/* =====================================================================
 * background.js — MV3 service worker / orchestrator
 * ---------------------------------------------------------------------
 * Owns the whole run:
 *   • holds the queue of CSV rows
 *   • drives a dedicated tab to bayt.com
 *   • injects content.js and tells it what to do (search / scrape)
 *   • collects every job row
 *   • builds the final CSV and triggers the download
 *
 * The popup is only a view — it can be closed at any time without
 * interrupting the run.
 * =================================================================== */

/* ------------------------------ Config ----------------------------- */
const BAYT_HOME       = 'https://www.bayt.com/en/';
const PAGE_LOAD_LIMIT = 60000;   // ms to wait for a page to finish loading
const STORAGE_KEY     = 'baytScraperState';
const MAX_LOG_LINES   = 200;

/* --------------------------- Run state ----------------------------- */
// Single source of truth for the current run. Mirrored to chrome.storage
// so a service-worker restart doesn't lose collected data.
let state = newState();

function newState() {
  return {
    running: false,
    stopRequested: false,
    tabId: null,
    rows: [],
    totalRows: 0,
    currentRow: 0,
    doneRows: 0,          // rows that finished cleanly
    errorRows: 0,         // rows that failed
    mode: 'csv',          // 'csv' = search each row | 'current' = Just Scrape
    withDetails: false,   // open every card and capture its full description
    maxPages: 1,
    minDelay: 2000,
    maxDelay: 4000,
    backgroundTab: false,
    results: [],
    logLines: [],
    message: '',
    lastSummary: ''
  };
}

/* ---------------------------------------------------------------------
 * Hydration: an idle MV3 worker is torn down and restarted on the next
 * event, so previously collected jobs are re-loaded from storage. This is
 * what makes "Download" / "Clear Data" work after the popup is reopened.
 * ------------------------------------------------------------------- */
const hydrated = new Promise((resolve) => {
  chrome.storage.local.get(STORAGE_KEY, (data) => {
    const saved = data && data[STORAGE_KEY];
    if (saved && !state.running) {
      state.results   = saved.results   || [];
      state.logLines  = saved.logLines  || [];
      state.totalRows = saved.totalRows || 0;
      state.doneRows  = saved.doneRows  || 0;
      state.errorRows = saved.errorRows || 0;
      state.currentRow  = saved.currentRow  || 0;
      state.lastSummary = saved.lastSummary || '';
      state.running = false;   // a run cannot survive a worker restart
    }
    resolve();
  });
});

/* =====================================================================
 * Small helpers
 * =================================================================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Random human-ish pause between actions (default 2–4 s). */
function humanDelay(minOverride, maxOverride) {
  const min = minOverride != null ? minOverride : state.minDelay;
  const max = maxOverride != null ? maxOverride : state.maxDelay;
  return sleep(Math.floor(min + Math.random() * Math.max(0, max - min)));
}

/** Push a progress update to the popup (silently ignored if it's closed). */
function report(patch) {
  if (patch.log) {
    state.logLines.push(patch.log);
    if (state.logLines.length > MAX_LOG_LINES) state.logLines.shift();
  }
  if (patch.message) state.message = patch.message;

  const payload = Object.assign({
    running: state.running,
    currentRow: state.currentRow,
    totalRows: state.totalRows,
    doneRows: state.doneRows,
    errorRows: state.errorRows,
    jobCount: state.results.length,
    hasData: state.results.length > 0
  }, patch);

  chrome.runtime.sendMessage({ type: 'PROGRESS', payload }, () => {
    // Reading lastError swallows the "no receiving end" noise when the
    // popup is closed — that is an expected, harmless condition.
    void chrome.runtime.lastError;
  });

  persist();
}

/** Mirror the run to storage so nothing is lost if the worker restarts. */
function persist() {
  chrome.storage.local.set({ [STORAGE_KEY]: {
    running: state.running,
    currentRow: state.currentRow,
    totalRows: state.totalRows,
    doneRows: state.doneRows,
    errorRows: state.errorRows,
    rows: state.rows,
    results: state.results,
    logLines: state.logLines,
    message: state.message,
    lastSummary: state.lastSummary
  }}, () => void chrome.runtime.lastError);
}

/* --- Promise wrappers around the callback-style tab APIs ------------ */
function getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(tab);
    });
  });
}

function updateTab(tabId, props) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, props, (tab) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tab);
    });
  });
}

function createTab(props) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(props, (tab) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tab);
    });
  });
}

function reloadTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, { bypassCache: false }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function queryTabs(query) {
  return new Promise((resolve) => {
    chrome.tabs.query(query, (tabs) => {
      void chrome.runtime.lastError;
      resolve(tabs || []);
    });
  });
}

const isBaytUrl = (url) => /^https?:\/\/(www\.)?bayt\.com\//i.test(url || '');

/**
 * Pick the tab to automate:
 *   1. the active tab, if the user is already sitting on bayt.com
 *   2. any other open bayt.com tab
 *   3. otherwise open a fresh one
 * Reusing a tab means the user's current page is refreshed and driven.
 */
async function resolveWorkTab(requireExisting) {
  const active = (await queryTabs({ active: true, currentWindow: true }))[0];
  if (active && isBaytUrl(active.url)) return { tab: active, reused: true };

  const existing = (await queryTabs({ url: ['*://www.bayt.com/*', '*://bayt.com/*'] }))[0];
  if (existing) return { tab: existing, reused: true };

  // "Just Scrape" has nowhere to go on its own — it reads the page the
  // user is looking at, so a missing Bayt tab is an error, not a cue to
  // open one.
  if (requireExisting) {
    throw new Error('Open a Bayt results page first, then press Scrape.');
  }

  const fresh = await createTab({ url: BAYT_HOME, active: !state.backgroundTab });
  return { tab: fresh, reused: false };
}

/** Wait for the tab to report "complete", whatever it is loading. */
async function waitUntilComplete(tabId) {
  const started = Date.now();
  while (Date.now() - started < PAGE_LOAD_LIMIT) {
    await sleep(400);
    const tab = await getTab(tabId);
    if (!tab) throw new Error('The Bayt tab was closed.');
    if (tab.status === 'complete') {
      await sleep(900);            // let late XHR-rendered content settle
      return tab;
    }
  }
  throw new Error('Timed out waiting for the page to load.');
}

/**
 * Navigate the tab to `url` and wait for it. If it is already on that URL
 * the page is reloaded instead, so every row starts from a clean widget.
 */
async function gotoUrl(tabId, url) {
  const cur = (await getTab(tabId) || {}).url || '';
  const same = cur.split('#')[0] === url.split('#')[0];

  if (same) await reloadTab(tabId);
  else await updateTab(tabId, { url: url });

  await sleep(700);                // give the load a chance to start
  return waitUntilComplete(tabId);
}

/**
 * Wait until the tab has actually navigated somewhere new AND finished
 * loading. Polling (rather than onUpdated alone) survives the case where
 * the "complete" event fires before our listener is attached.
 *
 * @param {number} tabId
 * @param {string} prevUrl URL before the action that triggers navigation
 * @param {boolean} requireChange false = accept "already loaded" as done
 */
async function waitForNavigation(tabId, prevUrl, requireChange = true) {
  const started = Date.now();
  let sawChange = !requireChange;

  while (Date.now() - started < PAGE_LOAD_LIMIT) {
    await sleep(400);

    const tab = await getTab(tabId);
    if (!tab) throw new Error('The Bayt tab was closed.');

    // A URL change is the usual signal, but re-running the very same
    // search lands on the same URL — so a load cycle counts too.
    if (tab.url && tab.url !== prevUrl) sawChange = true;
    if (tab.status === 'loading') sawChange = true;

    if (sawChange && tab.status === 'complete') {
      await sleep(900);          // let late XHR-rendered content settle
      return tab;
    }
  }
  throw new Error('Timed out waiting for the page to load.');
}

/** Inject content.js (it self-guards against double registration). */
async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ['content.js']
  });
}

/**
 * Send a message to content.js with a short retry loop — right after a
 * navigation the receiving end can need a moment to come up.
 */
function sendToTab(tabId, message, attempts = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      chrome.tabs.sendMessage(tabId, message, (res) => {
        if (chrome.runtime.lastError) {
          if (left > 0) return setTimeout(() => attempt(left - 1), 700);
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(res);
      });
    };
    attempt(attempts);
  });
}

/** Inject + ping, so we know the content script is alive before using it. */
async function ensureContentScript(tabId) {
  await injectContentScript(tabId);
  const pong = await sendToTab(tabId, { type: 'PING' });
  if (!pong || !pong.ok) throw new Error('Content script did not respond.');
}

/* ---------------------------------------------------------------------
 * Fallback: Bayt exposes clean, predictable search URLs, e.g.
 *   https://www.bayt.com/en/bahrain/jobs/software-engineer-jobs/
 * If the on-page widget ever changes and the UI flow fails, we still get
 * results by navigating straight to that URL.
 * ------------------------------------------------------------------- */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function buildFallbackUrl(searchText, location) {
  const loc = slugify(location);
  const kw  = slugify(searchText);
  if (loc && kw)  return 'https://www.bayt.com/en/' + loc + '/jobs/' + kw + '-jobs/';
  if (loc)        return 'https://www.bayt.com/en/' + loc + '/jobs/';
  if (kw)         return 'https://www.bayt.com/en/international/jobs/' + kw + '-jobs/';
  return BAYT_HOME;
}

/** Add/replace the ?page=N parameter on a results URL. */
function withPage(url, page) {
  try {
    const u = new URL(url);
    u.searchParams.set('page', String(page));
    return u.toString();
  } catch (e) {
    return url;
  }
}

/* =====================================================================
 * The main run loop
 * =================================================================== */
async function runScrape(payload) {
  const carriedResults = state.results;    // keep anything already stored
  state = newState();
  state.running       = true;
  state.rows          = payload.rows;
  state.totalRows     = payload.mode === 'current' ? 1 : payload.rows.length;
  state.mode          = payload.mode === 'current' ? 'current' : 'csv';
  state.maxPages      = payload.maxPages || 1;
  state.minDelay      = payload.minDelay || 2000;
  state.maxDelay      = payload.maxDelay || 4000;
  state.backgroundTab = !!payload.backgroundTab;
  state.withDetails   = !!payload.withDetails;
  state.results       = carriedResults;

  keepAlive(true);

  if (state.mode === 'current') {
    report({ message: 'Reading the open page…', log: '▶ Just Scrape — current page' });
  } else {
    report({ message: 'Opening Bayt…', log: '▶ Run started (' + state.totalRows + ' searches)' });
  }

  try {
    // ---------------- Just Scrape: no CSV, no searching ---------------
    if (state.mode === 'current') {
      const found = await justScrape();

      if (!found) {
        state.errorRows = 1;
        finish('No job cards found on that page.', 'err');
        return;
      }

      const filename = await downloadResults(state.results);
      finish('Done — ' + found + ' job(s) from this page, ' +
             state.results.length + ' saved to ' + filename, 'ok');
      return;
    }

    // Reuse a Bayt tab if one is already open (it gets refreshed);
    // otherwise open a dedicated one.
    const picked = await resolveWorkTab();
    state.tabId = picked.tab.id;

    if (picked.reused) {
      // Leave the page where it is — if it already carries the search
      // widget (results pages do), processRow() searches straight from it.
      report({ log: '   ↻ Reusing the open Bayt tab' });
      if (!state.backgroundTab) await updateTab(state.tabId, { active: true });
      await waitUntilComplete(state.tabId);
    } else {
      await waitUntilComplete(state.tabId);
    }

    for (let i = 0; i < state.rows.length; i++) {
      if (state.stopRequested) break;

      state.currentRow = i + 1;
      const row = state.rows[i];
      const label = '"' + row.searchText + '" @ ' + (row.location || 'any');

      report({
        message: 'Scraping row ' + (i + 1) + ' of ' + state.totalRows + '…',
        log: '── Row ' + (i + 1) + ': ' + label
      });

      try {
        const jobs = await processRow(row);
        state.results.push.apply(state.results, jobs);
        state.doneRows++;
        report({ log: '   ✓ ' + jobs.length + ' job(s) captured' });
      } catch (err) {
        // One bad row must never kill the whole run.
        state.errorRows++;
        report({ log: '   ✗ ' + err.message });
      }

      if (i < state.rows.length - 1) await humanDelay();
    }

    // ---------------- Finish: build + download the CSV ---------------
    if (!state.results.length) {
      finish('Finished — but no jobs were captured.', 'err');
      return;
    }

    const filename = await downloadResults(state.results);
    const stoppedEarly = state.stopRequested ? ' (stopped early)' : '';
    finish('Done' + stoppedEarly + ' — ' + state.results.length + ' jobs saved to ' + filename, 'ok');

  } catch (err) {
    // Fatal error (tab closed, no network, …). Still save what we have.
    if (state.results.length) {
      try {
        const filename = await downloadResults(state.results);
        finish('Stopped: ' + err.message + ' — ' + state.results.length + ' jobs saved to ' + filename, 'err');
        return;
      } catch (e) { /* fall through to the plain error below */ }
    }
    finish('Stopped: ' + err.message, 'err');
  }
}

function finish(summary, level) {
  state.running = false;
  state.stopRequested = false;
  state.lastSummary = summary;
  keepAlive(false);
  report({ message: summary, level: level, log: '■ ' + summary, done: true, running: false });
}

/* ---------------------------------------------------------------------
 * "Just Scrape": take whatever results page the user already has open and
 * read it — no CSV, no typing, no navigation. Honours the pagination count
 * so it can also walk on from where it is.
 *
 * @returns {Promise<number>} how many jobs this page (and its extra pages)
 *                            yielded — 0 means there was nothing to read.
 * ------------------------------------------------------------------- */
async function justScrape() {
  const picked = await resolveWorkTab(true);   // throws if no Bayt tab
  state.tabId = picked.tab.id;
  state.totalRows = 1;

  await waitUntilComplete(state.tabId);
  await ensureContentScript(state.tabId);

  // Label the rows with whatever the page's own search box says, so the
  // export still shows where the jobs came from.
  let row = { searchText: '', location: '' };
  try {
    const info = await sendToTab(state.tabId, { type: 'PAGE_INFO' });
    if (info && info.ok) {
      row = { searchText: info.keyword || '', location: info.location || '' };
    }
  } catch (e) { /* labels are optional */ }

  report({ log: '   ⇢ ' + (picked.tab.title || picked.tab.url || 'current page') });

  const jobs = await scrapePages(state.tabId, row);
  state.results.push.apply(state.results, jobs);
  state.currentRow = 1;
  state.doneRows = jobs.length ? 1 : 0;

  if (jobs.length) report({ log: '   ✓ ' + jobs.length + ' job(s) captured' });
  return jobs.length;
}

/* ---------------------------------------------------------------------
 * One CSV row = one search = 1..maxPages result pages.
 * ------------------------------------------------------------------- */
async function processRow(row) {
  const tabId = state.tabId;
  let usedFallback = false;

  // --- 1. Get to a page that carries the search widget ----------------
  // The widget lives in the header of the home page *and* of every results
  // page, so once a search has run we keep searching from where we are
  // instead of loading the home page again for every row.
  //
  // The exception is a row with a blank keyword or blank location: the
  // widget would still hold the previous row's value with nothing typed
  // over it, so those rows start from the home page's clean widget.
  const needsCleanWidget = !row.searchText || !row.location;
  let searchInPlace = false;

  if (!needsCleanWidget && isBaytUrl((await getTab(tabId) || {}).url)) {
    try {
      await ensureContentScript(tabId);
      const widget = await sendToTab(tabId, { type: 'HAS_WIDGET' });
      searchInPlace = !!(widget && widget.ok && widget.hasWidget);
    } catch (e) {
      searchInPlace = false;      // fall back to the home page below
    }
  }

  if (searchInPlace) {
    report({ log: '   ⇢ Searching from the current page' });
  } else {
    await gotoUrl(tabId, BAYT_HOME);
    await ensureContentScript(tabId);
  }

  await humanDelay(600, 1200);

  // --- 2. Fill the search box + pick the location from the dropdown ---
  let prepared = null;
  try {
    prepared = await sendToTab(tabId, {
      type: 'PREPARE_SEARCH',
      searchText: row.searchText,
      location: row.location
    });
  } catch (err) {
    prepared = { ok: false, error: err.message };
  }

  const resultsUrlBefore = (await getTab(tabId) || {}).url || '';

  if (prepared && prepared.ok) {
    if (!prepared.locationSelected && row.location) {
      report({ log: '   ! Location dropdown did not match "' + row.location + '" — using direct URL' });
      usedFallback = true;
    } else {
      // --- 3. Submit and wait for the results page --------------------
      await humanDelay();
      try {
        await sendToTab(tabId, { type: 'SUBMIT_SEARCH' });
        await waitForNavigation(tabId, resultsUrlBefore, true);
      } catch (err) {
        report({ log: '   ! Search submit failed (' + err.message + ') — using direct URL' });
        usedFallback = true;
      }
    }
  } else {
    report({ log: '   ! Search widget unavailable — using direct URL' });
    usedFallback = true;
  }

  // --- 3b. Fallback path: go straight to the canonical results URL ----
  if (usedFallback) {
    await gotoUrl(tabId, buildFallbackUrl(row.searchText, row.location));
  }

  // --- 4. Scrape page 1, then any extra pages -------------------------
  return scrapePages(tabId, row);
}

/* ---------------------------------------------------------------------
 * Scrape the results page the tab is currently on, then follow the
 * pagination strip for up to `state.maxPages` pages. Shared by the CSV
 * flow and by "Just Scrape".
 *
 * @param {number} tabId
 * @param {{searchText: string, location: string}} row labels for the CSV
 * @returns {Promise<Array>} the jobs collected across those pages
 * ------------------------------------------------------------------- */
async function scrapePages(tabId, row) {
  const collected = [];
  let resultsUrl = (await getTab(tabId) || {}).url || '';
  let nextUrl = null;          // resolved from the page we are standing on
  let sawPagination = false;   // did that page actually have a strip?

  for (let page = 1; page <= state.maxPages; page++) {
    if (state.stopRequested) break;

    if (page > 1) {
      // nextUrl was read from the previous page's #pagination strip, so it
      // keeps any filters already in the URL. Only if no strip was found do
      // we fall back to a constructed ?page=N.
      const target = nextUrl || withPage(resultsUrl, page);
      const cur = (await getTab(tabId) || {}).url || '';
      if (target === cur) break;                       // nothing more to do
      await humanDelay();
      await gotoUrl(tabId, target);
    }

    await ensureContentScript(tabId);
    const res = await sendToTab(tabId, {
      type: 'SCRAPE',
      withDetails: state.withDetails
    });

    if (!res || !res.ok) throw new Error((res && res.error) || 'Scrape failed.');
    if (!res.jobs.length) {
      report({ log: '   · page ' + page + ': no job cards found' });
      break;                                           // past the last page
    }

    // Stamp each job with the search that produced it.
    res.jobs.forEach((job) => {
      job.searchText = row.searchText;
      job.searchLocation = row.location;
      job.page = page;
      job.scrapedAt = new Date().toISOString();
      collected.push(job);
    });

    report({
      log: '   · page ' + page + ': ' + res.jobs.length + ' job(s)',
      jobCount: state.results.length + collected.length
    });

    // resultsUrl stays as captured on entry: opening a detail panel can
    // push a ?jobId= onto the address bar, which must not leak into the
    // pagination fallback URL.
    if (page >= state.maxPages) break;

    // --- Look ahead while we are still on this page ---------------------
    nextUrl = null;
    sawPagination = false;
    try {
      const nav = await sendToTab(tabId, { type: 'PAGE_URL', page: page + 1 });
      if (nav && nav.ok) {
        sawPagination = nav.linkCount > 0;
        nextUrl = nav.url;
      }
    } catch (e) { /* treat as "no pagination info" */ }

    if (sawPagination && !nextUrl) {
      report({ log: '   · page ' + page + ' is the last page' });
      break;
    }
    // With no strip to trust, a short page is the only end-of-results hint.
    if (!sawPagination && res.jobs.length < 5) break;
  }

  return collected;
}

/* =====================================================================
 * CSV OUTPUT
 * =================================================================== */
const CSV_COLUMNS = [
  { key: 'searchText',     header: 'Search_Text' },
  { key: 'searchLocation', header: 'Search_Location' },
  { key: 'title',          header: 'Job_Title' },
  { key: 'company',        header: 'Company' },
  { key: 'location',       header: 'Job_Location' },
  { key: 'careerLevel',    header: 'Career_Level' },
  { key: 'experience',     header: 'Experience' },
  { key: 'remote',         header: 'Remote' },
  { key: 'otherInfo',      header: 'Other_Info' },
  { key: 'summary',        header: 'Summary' },
  { key: 'details',        header: 'Job_Details' },
  { key: 'date',           header: 'Job_Date' },
  { key: 'url',            header: 'Job_URL' },
  { key: 'page',           header: 'Result_Page' },
  { key: 'scrapedAt',      header: 'Scraped_At' }
];

/** Escape one cell for CSV (quotes doubled, field wrapped when needed). */
function csvCell(value) {
  const s = (value === null || value === undefined) ? '' : String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCSV(rows) {
  const lines = [CSV_COLUMNS.map((c) => csvCell(c.header)).join(',')];
  rows.forEach((row) => {
    lines.push(CSV_COLUMNS.map((c) => csvCell(row[c.key])).join(','));
  });
  return lines.join('\r\n');
}

/**
 * Trigger the download.
 * MV3 service workers have no URL.createObjectURL, so the CSV is handed
 * to chrome.downloads as a data: URL. The leading BOM makes Excel open
 * UTF-8 (Arabic company names etc.) correctly.
 */
function downloadResults(rows) {
  const csv = '﻿' + buildCSV(rows);   // BOM so Excel reads UTF-8
  const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const filename = 'bayt-jobs-' + stamp + '.csv';

  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false
    }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(filename);
    });
  });
}

/* =====================================================================
 * Keep-alive
 * ---------------------------------------------------------------------
 * An MV3 worker is torn down after ~30 s idle. Touching a chrome.* API on
 * a timer while a run is active keeps it resident through the long waits.
 * =================================================================== */
let keepAliveTimer = null;

function keepAlive(on) {
  if (on && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    }, 20000);
  } else if (!on && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/* =====================================================================
 * Message router (popup ⇄ background)
 * =================================================================== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {

    case 'START_SCRAPE':
      if (state.running) {
        sendResponse({ ok: false, error: 'A scrape is already running.' });
        return;
      }
      // "Just Scrape" needs no rows — it reads the open page.
      if (!msg.payload ||
          (msg.payload.mode !== 'current' &&
           (!msg.payload.rows || !msg.payload.rows.length))) {
        sendResponse({ ok: false, error: 'No rows supplied.' });
        return;
      }
      sendResponse({ ok: true });
      hydrated.then(() => runScrape(msg.payload));   // progress is pushed
      return;

    // Emitted by content.js while it walks the cards for full details.
    case 'DETAIL_PROGRESS':
      if (state.running) {
        report({ message: 'Reading job ' + msg.index + ' of ' + msg.total + '…' });
      }
      return;

    case 'STOP_SCRAPE':
      state.stopRequested = true;
      // The full-description pass can spend a minute inside one page, so
      // tell the content script directly rather than making the user wait
      // for it to finish. executeScript shares the content script's
      // isolated world, so this flag is visible to it.
      if (state.tabId) {
        chrome.scripting.executeScript({
          target: { tabId: state.tabId },
          func: () => { window.__baytScraperStop = true; }
        }, () => void chrome.runtime.lastError);
      }
      report({ log: '⏸ Stop requested…' });
      sendResponse({ ok: true });
      return;

    // Re-export the stored jobs without re-scraping.
    case 'DOWNLOAD_NOW':
      hydrated.then(() => {
        if (!state.results.length) {
          sendResponse({ ok: false, error: 'Nothing stored yet.' });
          return;
        }
        downloadResults(state.results)
          .then((filename) => sendResponse({ ok: true, filename: filename }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
      });
      return true;      // async reply

    case 'CLEAR_DATA':
      hydrated.then(() => {
        if (state.running) {
          sendResponse({ ok: false, error: 'Stop the run first.' });
          return;
        }
        state = newState();
        chrome.storage.local.remove(STORAGE_KEY, () => void chrome.runtime.lastError);
        sendResponse({ ok: true });
      });
      return true;      // async reply

    case 'GET_STATE':
      hydrated.then(() => {
        sendResponse({
          running: state.running,
          currentRow: state.currentRow,
          totalRows: state.totalRows,
          doneRows: state.doneRows,
          errorRows: state.errorRows,
          rows: state.rows,
          jobCount: state.results.length,
          hasData: state.results.length > 0,
          logLines: state.logLines,
          message: state.message,
          lastSummary: state.lastSummary
        });
      });
      return true;      // async reply
  }
});

/* If the automation tab is closed mid-run, stop cleanly. */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.running && tabId === state.tabId) state.stopRequested = true;
});
