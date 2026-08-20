/* =====================================================================
 * content.js — page-level automation for bayt.com
 * ---------------------------------------------------------------------
 * Injected on demand by background.js. Handles three commands:
 *
 *   PING           → "are you alive?"
 *   PREPARE_SEARCH → type the keyword + pick the location from the dropdown
 *   SUBMIT_SEARCH  → click "Find jobs"
 *   SCRAPE         → read every job card on the current results page
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │ MAINTENANCE: every selector Bayt could change lives in the SEL    │
 * │ object below. If the site is redesigned, edit SEL only — nothing  │
 * │ else in this file hard-codes a selector.                          │
 * └───────────────────────────────────────────────────────────────────┘
 * =================================================================== */

(function () {
  'use strict';

  // The script is re-injected after every navigation. Registering the
  // listener twice would answer each message twice, so bail out early.
  if (window.__baytScraperInjected) return;
  window.__baytScraperInjected = true;

  /* ===================================================================
   * SELECTOR MAP  (edit here when Bayt changes its markup)
   * ================================================================= */
  const SEL = {
    // --- Search widget (lives in the header: /html/body/header/div[2]) --
    // NOTE: #text_search has its own autocomplete (data-searchable, 400 ms
    // debounce) that renders the SAME a[data-highlight] markup as the
    // country list, so it is closed before the location is touched.
    searchInput:   '#text_search',                     // XPath: //*[@id="text_search"]
    locationInput: '#search_country__r',               // XPath: //*[@id="search_country__r"]
    submitButton:  '#submitButtonQuickSearchWidget',   // XPath: //*[@id="submitButtonQuickSearchWidget"]

    // Autocomplete entries, e.g. <a tabindex="-1" data-highlight="" href="#">Algeria</a>
    locationOptions: [
      'a[data-highlight]',
      '.ui-autocomplete li a',
      '[role="listbox"] a',
      'ul.dropdown-menu li a'
    ],

    // --- Results list -------------------------------------------------
    // XPath of the container: /html/body/section[1]/div[2]/div[2]/div/div[1]
    // Tried in order; the first selector that yields real cards wins.
    jobCards: [
      '#results_inner_card ul li[data-js-job]',
      '#results_inner_card ul li.has-pointer-d',
      '#results_inner_card ul > li',
      'li[data-js-job]',
      'div#results_inner_card li'
    ],

    // --- Fields inside one job card ------------------------------------
    cardTitle:   ['h2 a', 'a[data-js-aid="jobID"]', 'h2'],
    cardCompany: ['.jb-company', 'b.jb-company', '[class*="jb-company"]', '.t-nowrap b'],
    cardLoc:     ['.jb-loc', '[class*="jb-loc"]', '[class*="t-mute"] .u-icon-location'],
    cardSummary: ['.jb-descr', '[class*="jb-descr"]', 'div.m10t.t-small'],
    cardDate:    ['.jb-date', '[class*="jb-date"]', 'div.jb-date span'],

    // --- Cookie consent ("We value your privacy") -----------------------
    cookieAccept: [
      '#onetrust-accept-btn-handler',
      '[data-js-aid="acceptCookies"]',
      '.js-cookie-accept',
      '#cookie-consent button'
    ]
  };

  /* Fallback XPaths, kept verbatim from the manual DOM inspection. Used
     only if every CSS selector above fails. */
  const XP = {
    searchInput:   '//*[@id="text_search"]',
    locationInput: '//*[@id="search_country__r"]',
    submitButton:  '//*[@id="submitButtonQuickSearchWidget"]',
    jobCards:      '//*[@id="results_inner_card"]/ul/li',
    resultsBox:    '/html/body/section[1]/div[2]/div[2]/div/div[1]'
  };

  /* ===================================================================
   * GENERIC DOM HELPERS
   * ================================================================= */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Random human-ish pause. */
  const rand = (min, max) => sleep(min + Math.random() * (max - min));

  /** Evaluate an XPath and return the first matching element (or null). */
  function byXPath(xpath, ctx) {
    try {
      const r = document.evaluate(
        xpath, ctx || document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      return r.singleNodeValue;
    } catch (e) {
      return null;
    }
  }

  /** Evaluate an XPath and return every matching element. */
  function allByXPath(xpath, ctx) {
    const out = [];
    try {
      const r = document.evaluate(
        xpath, ctx || document, null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
      );
      for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
    } catch (e) { /* malformed XPath — return what we have */ }
    return out;
  }

  /** First element matching any selector in the list. */
  function pick(selectors, ctx) {
    const root = ctx || document;
    for (const sel of [].concat(selectors)) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (e) { /* invalid selector — try the next one */ }
    }
    return null;
  }

  /** Every element matching any selector in the list (first list that hits). */
  function pickAll(selectors, ctx) {
    const root = ctx || document;
    for (const sel of [].concat(selectors)) {
      try {
        const els = root.querySelectorAll(sel);
        if (els.length) return Array.from(els);
      } catch (e) { /* invalid selector — try the next one */ }
    }
    return [];
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  /**
   * Wait until `check()` returns something truthy.
   * Uses a MutationObserver (instant reaction to DOM changes) plus a slow
   * poll, which also covers changes that don't mutate the DOM tree.
   *
   * @param {Function} check returns the value to resolve with, or null
   * @param {number} timeout ms
   * @returns {Promise<*>} resolves with check()'s value, or null on timeout
   */
  function waitFor(check, timeout = 12000) {
    return new Promise((resolve) => {
      let done = false;

      const finish = (val) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(timer);
        resolve(val);
      };

      const attempt = () => {
        let val = null;
        try { val = check(); } catch (e) { val = null; }
        if (val) finish(val);
      };

      const observer = new MutationObserver(attempt);
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true
      });

      const poll  = setInterval(attempt, 250);
      const timer = setTimeout(() => finish(null), timeout);

      attempt();   // it may already be there
    });
  }

  /** Wait for an element matching any of `selectors` (falls back to XPath). */
  function waitForElement(selectors, xpath, timeout) {
    return waitFor(() => {
      const el = pick(selectors);
      if (el) return el;
      return xpath ? byXPath(xpath) : null;
    }, timeout);
  }

  /**
   * Set an input's value the way a real user would.
   * React/Vue-style widgets ignore `el.value = x`, so we go through the
   * native value setter and then fire the events frameworks listen for.
   */
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fireInputEvents(el) {
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  }

  /**
   * Type text character by character, firing key events after each one.
   * Autocomplete widgets (like the country selector) only open in
   * response to real keystrokes, so this is deliberately not a bulk set.
   */
  async function typeInto(el, text, perCharDelay = 55) {
    el.focus();
    el.click();
    setNativeValue(el, '');
    fireInputEvents(el);

    for (const ch of String(text)) {
      setNativeValue(el, el.value + ch);
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ch }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ch }));
      await sleep(perCharDelay + Math.random() * 45);   // uneven, human rhythm
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** A click that satisfies widgets listening for mousedown/mouseup. */
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    if (typeof el.click === 'function') { try { el.click(); } catch (e) {} }
  }

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  /**
   * Dismiss the "We value your privacy" bar. It floats over the page and
   * can swallow clicks, so it is cleared before any interaction.
   * Failure is fine — the banner is not always shown.
   */
  function dismissCookieBanner() {
    try {
      const direct = pick(SEL.cookieAccept);
      if (direct && isVisible(direct)) { realClick(direct); return true; }

      // Fall back to matching the button label, kept strict on purpose so
      // no unrelated "Accept" control is ever clicked.
      const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const hit = controls.find((c) =>
        isVisible(c) && /^(accept(\s+all)?(\s+cookies)?|i\s+agree|agree|got\s+it)$/i
          .test(clean(c.innerText || c.textContent)));
      if (hit) { realClick(hit); return true; }
    } catch (e) { /* never block the run on the banner */ }
    return false;
  }

  /** Close an open autocomplete list without changing the typed value. */
  function closeAutocomplete(el) {
    try {
      const esc = { bubbles: true, key: 'Escape', code: 'Escape', keyCode: 27, which: 27 };
      el.dispatchEvent(new KeyboardEvent('keydown', esc));
      el.dispatchEvent(new KeyboardEvent('keyup', esc));
      el.blur();
      // Many widgets close on an outside mousedown.
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    } catch (e) { /* best effort */ }
  }

  /* ===================================================================
   * STEP 1 — SEARCH KEYWORD
   * ================================================================= */
  async function fillSearch(searchText) {
    const input = await waitForElement(SEL.searchInput, XP.searchInput, 15000);
    if (!input) throw new Error('Search box (#text_search) not found.');

    input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await rand(250, 600);

    if (searchText) {
      await typeInto(input, searchText, 45);
      // The keyword suggestion list is open now (400 ms debounce). Close it
      // so it cannot cover the "Find jobs" button or be mistaken for the
      // country list in the next step.
      await rand(500, 900);
      closeAutocomplete(input);
      await rand(200, 400);
    } else {
      // Blank keyword = "all jobs in this location" — clear any leftover text.
      setNativeValue(input, '');
      fireInputEvents(input);
    }
    return true;
  }

  /* ===================================================================
   * STEP 2 — LOCATION AUTOCOMPLETE
   * ---------------------------------------------------------------
   * Click the field, type the location, wait for the suggestion list,
   * then click the <a> whose text matches. Matching is tiered:
   *   exact → startsWith → contains
   * ================================================================= */
  async function selectLocation(location) {
    if (!location) return true;                 // nothing to pick

    const input = await waitForElement(SEL.locationInput, XP.locationInput, 15000);
    if (!input) throw new Error('Location box (#search_country__r) not found.');

    input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await rand(250, 600);

    await typeInto(input, location, 75);        // slower: the widget debounces

    // Wait for at least one *visible* suggestion to appear.
    const wanted = location.trim().toLowerCase();
    const inputRect = input.getBoundingClientRect();

    // The dropdown renders bottom-left of its own input ("placement":"bl"),
    // which is how a stray keyword list is told apart from the country list.
    const belongsToLocation = (a) => {
      const r = a.getBoundingClientRect();
      return Math.abs(r.left - inputRect.left) <= 90 && r.top >= inputRect.top - 12;
    };

    const match = await waitFor(() => {
      let options = pickAll(SEL.locationOptions).filter(isVisible);
      if (!options.length) return null;

      const own = options.filter(belongsToLocation);
      if (own.length) options = own;

      const texts = options.map((a) => ({ el: a, txt: clean(a.textContent).toLowerCase() }));

      return texts.find((o) => o.txt === wanted)                 // exact
          || texts.find((o) => o.txt.startsWith(wanted))         // prefix
          || texts.find((o) => o.txt.indexOf(wanted) !== -1)     // contains
          || null;
    }, 9000);

    if (!match) {
      // No suggestion matched. background.js will fall back to a direct
      // results URL rather than searching the wrong country.
      return false;
    }

    await rand(200, 500);
    match.el.scrollIntoView({ block: 'nearest' });
    realClick(match.el);
    await rand(400, 900);

    return true;
  }

  /* ===================================================================
   * STEP 3 — SUBMIT
   * ================================================================= */
  async function submitSearch() {
    const btn = await waitForElement(SEL.submitButton, XP.submitButton, 10000);

    if (btn) { realClick(btn); return true; }

    // Last resort: submit the form the search box belongs to.
    const input = pick(SEL.searchInput) || byXPath(XP.searchInput);
    if (input && input.form) { input.form.submit(); return true; }

    throw new Error('"Find jobs" button not found.');
  }

  /* ===================================================================
   * STEP 4 — SCRAPE THE RESULTS PAGE
   * ================================================================= */

  /** Nudge the page so lazy-loaded cards render before we read them. */
  async function autoScroll() {
    const step = Math.round(window.innerHeight * 0.85);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await sleep(180);
    }
    window.scrollTo(0, 0);
    await sleep(300);
  }

  /** Collect the job-card <li> elements, filtering out utility rows. */
  function getJobCards() {
    let cards = pickAll(SEL.jobCards);
    if (!cards.length) cards = allByXPath(XP.jobCards);

    return cards.filter((li) => {
      if (!li || li.nodeType !== 1) return false;
      // A real card always links to a job page. This drops ad slots,
      // "create a job alert" rows and hidden template <li>s.
      const link = pick(SEL.cardTitle, li);
      if (!link) return false;
      const href = link.getAttribute && link.getAttribute('href');
      return !!(href && /\/job/i.test(href));
    });
  }

  /** Strip Bayt's AI prefix ("✨ Summary: …") and squash whitespace. */
  function cleanSummary(raw) {
    let s = clean(raw);
    s = s.replace(/^[^A-Za-z0-9]*\s*(AI\s*)?Summary\s*[:：-]\s*/i, '');
    return s;
  }

  /** Read one card. Any missing field yields "N/A" instead of throwing. */
  function parseCard(li) {
    const job = {
      title: 'N/A', url: 'N/A', company: 'N/A',
      location: 'N/A', summary: 'N/A', date: 'N/A'
    };

    // --- Title + URL ---------------------------------------------------
    try {
      const a = pick(SEL.cardTitle, li);
      if (a) {
        job.title = clean(a.innerText || a.textContent) || 'N/A';
        const href = a.getAttribute('href');
        if (href) job.url = new URL(href, location.origin).href;
      }
    } catch (e) { /* keep N/A */ }

    // --- Company -------------------------------------------------------
    try {
      const c = pick(SEL.cardCompany, li);
      if (c) job.company = clean(c.innerText || c.textContent) || 'N/A';
    } catch (e) { /* keep N/A */ }

    // --- Job location ---------------------------------------------------
    try {
      const l = pick(SEL.cardLoc, li);
      if (l) job.location = clean(l.innerText || l.textContent) || 'N/A';
    } catch (e) { /* keep N/A */ }

    // --- Summary --------------------------------------------------------
    try {
      const d = pick(SEL.cardSummary, li);
      if (d) job.summary = cleanSummary(d.innerText || d.textContent) || 'N/A';
    } catch (e) { /* keep N/A */ }

    // --- Posted date ("6 days ago") --------------------------------------
    try {
      const dt = pick(SEL.cardDate, li);
      if (dt) job.date = clean(dt.innerText || dt.textContent) || 'N/A';
    } catch (e) { /* keep N/A */ }

    return job;
  }

  async function scrapePage() {
    // Give the results list a chance to appear before reading it.
    await waitFor(() => (getJobCards().length ? true : null), 15000);
    await autoScroll();

    const cards = getJobCards();
    const jobs = [];
    const seen = new Set();

    cards.forEach((li) => {
      try {
        const job = parseCard(li);
        if (job.title === 'N/A' && job.url === 'N/A') return;   // empty row
        const key = job.url !== 'N/A' ? job.url : job.title + '|' + job.company;
        if (seen.has(key)) return;                              // de-duplicate
        seen.add(key);
        jobs.push(job);
      } catch (e) {
        // One malformed card must never abort the page.
      }
    });

    return jobs;
  }

  /* ===================================================================
   * MESSAGE ROUTER
   * ---------------------------------------------------------------
   * `return true` keeps the message channel open for the async reply.
   * ================================================================= */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'PING') {
      sendResponse({ ok: true, url: location.href });
      return;
    }

    if (msg.type === 'PREPARE_SEARCH') {
      (async () => {
        try {
          dismissCookieBanner();          // clear any overlay first
          await rand(300, 600);
          await fillSearch(msg.searchText);
          await rand(400, 900);
          const locationSelected = await selectLocation(msg.location);
          sendResponse({ ok: true, locationSelected: locationSelected });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    if (msg.type === 'SUBMIT_SEARCH') {
      // Reply FIRST: the click navigates away and would otherwise tear
      // this script down before the response is delivered.
      sendResponse({ ok: true });
      setTimeout(() => { submitSearch().catch(() => {}); }, 120);
      return;
    }

    if (msg.type === 'SCRAPE') {
      (async () => {
        try {
          dismissCookieBanner();
          const jobs = await scrapePage();
          sendResponse({ ok: true, jobs: jobs, url: location.href });
        } catch (err) {
          sendResponse({ ok: false, error: err.message, jobs: [] });
        }
      })();
      return true;
    }
  });
})();
