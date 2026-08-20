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
async function resolveWorkTab() {
  const active = (await queryTabs({ active: true, currentWindow: true }))[0];
  if (active && isBaytUrl(active.url)) return { tab: active, reused: true };

  const existing = (await queryTabs({ url: ['*://www.bayt.com/*', '*://bayt.com/*'] }))[0];
  if (existing) return { tab: existing, reused: true };

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

    if (tab.url && tab.url !== prevUrl) sawChange = true;
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
  state.totalRows     = payload.rows.length;
  state.maxPages      = payload.maxPages || 1;
  state.minDelay      = payload.minDelay || 2000;
  state.maxDelay      = payload.maxDelay || 4000;
  state.backgroundTab = !!payload.backgroundTab;
  state.results       = carriedResults;

  keepAlive(true);
  report({ message: 'Opening Bayt…', log: '▶ Run started (' + state.totalRows + ' searches)' });

  try {
    // Reuse a Bayt tab if one is already open (it gets refreshed);
    // otherwise open a dedicated one.
    const picked = await resolveWorkTab();
    state.tabId = picked.tab.id;

    if (picked.reused) {
      report({ log: '   ↻ Reusing the open Bayt tab' });
      if (!state.backgroundTab) await updateTab(state.tabId, { active: true });
      await gotoUrl(state.tabId, BAYT_HOME);
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
 * One CSV row = one search = 1..maxPages result pages.
 * ------------------------------------------------------------------- */
async function processRow(row) {
  const tabId = state.tabId;
  let usedFallback = false;

  // --- 1. Land on the Bayt home page (its header carries the search
  //        widget: /html/body/header/div[2]). Already there? Refresh, so
  //        the previous row's keyword/location can't leak into this one.
  await gotoUrl(tabId, BAYT_HOME);
  await ensureContentScript(tabId);
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

  // --- 4. Scrape page 1, then optional extra pages --------------------
  const collected = [];
  let resultsUrl = (await getTab(tabId) || {}).url || '';

  for (let page = 1; page <= state.maxPages; page++) {
    if (state.stopRequested) break;

    if (page > 1) {
      const target = withPage(resultsUrl, page);
      const cur = (await getTab(tabId) || {}).url || '';
      if (target === cur) break;                       // nothing more to do
      await humanDelay();
      await gotoUrl(tabId, target);
    }

    await ensureContentScript(tabId);
    const res = await sendToTab(tabId, { type: 'SCRAPE' });

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

    if (page === 1) resultsUrl = (await getTab(tabId) || {}).url || resultsUrl;
    if (res.jobs.length < 5) break;                    // likely the last page
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
  { key: 'summary',        header: 'Summary' },
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
      if (!msg.payload || !msg.payload.rows || !msg.payload.rows.length) {
        sendResponse({ ok: false, error: 'No rows supplied.' });
        return;
      }
      sendResponse({ ok: true });
      hydrated.then(() => runScrape(msg.payload));   // progress is pushed
      return;

    case 'STOP_SCRAPE':
      state.stopRequested = true;
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
