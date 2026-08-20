/* =====================================================================
 * popup.js — UI layer
 * ---------------------------------------------------------------------
 * Responsibilities:
 *   1. Read + parse the user's CSV (dependency-free parser, see parseCSV).
 *   2. Hand the selected row range to background.js (the orchestrator).
 *   3. Render the live counters/progress that background.js pushes back.
 *   4. Offer "Download" (re-export whatever is stored) and "Clear Data".
 *
 * NOTE ON PapaParse: Manifest V3's CSP blocks remote scripts, so a CDN
 * <script> tag would silently fail. The parser below covers everything a
 * two-column job CSV needs (quoted fields, embedded commas/newlines,
 * escaped double-quotes, CRLF, UTF-8 BOM).
 * =================================================================== */

/* ------------------------- DOM shortcuts --------------------------- */
const $ = (id) => document.getElementById(id);

const fileInput   = $('csvFile');
const fileDrop    = $('fileDrop');
const fileName    = $('fileName');
const modeSel     = $('mode');
const maxPagesEl  = $('maxPages');
const pillPages   = $('pillPages');
const minDelayEl  = $('minDelay');
const startRowEl  = $('startRow');
const endRowEl    = $('endRow');
const bgTabEl     = $('bgTab');
const startBtn    = $('startBtn');
const stopBtn     = $('stopBtn');
const downloadBtn = $('downloadBtn');
const clearBtn    = $('clearBtn');
const statusEl    = $('status');
const logEl       = $('log');

let parsedRows = [];   // [{ searchText, location }, ...] — the full CSV

// Fallback input shipped with the extension, used when nothing is uploaded.
const BUNDLED_CSV = 'input.csv';

/* =====================================================================
 * 1. CSV PARSING
 * =================================================================== */

/**
 * Minimal RFC-4180 CSV parser.
 * @param {string} text raw file contents
 * @returns {string[][]} rows of cells
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  text = text.replace(/^﻿/, '');     // strip UTF-8 BOM
  text = text.replace(/\r\n?/g, '\n');    // normalise CRLF / CR -> LF

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }  // escaped quote ("")
        else inQuotes = false;                          // closing quote
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"')       inQuotes = true;
    else if (ch === ',')  { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else                  cell += ch;
  }

  // Flush the trailing cell/row (a file need not end with a newline).
  row.push(cell);
  rows.push(row);

  // Drop rows that are entirely blank.
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/**
 * Map the raw CSV grid onto { searchText, location } objects.
 * Header names are matched loosely, so "Search_Text" / "search text" /
 * "keyword" / "query" all work. With no recognisable header, column 0 is
 * treated as the search text and column 1 as the location.
 */
function rowsToJobs(grid) {
  if (!grid.length) return [];

  const norm = (s) => String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const header = grid[0].map(norm);

  const SEARCH_KEYS = ['searchtext', 'search', 'keyword', 'keywords', 'query', 'jobtitle', 'title'];
  const LOC_KEYS    = ['location', 'country', 'city', 'place', 'region'];

  let sIdx = header.findIndex((h) => SEARCH_KEYS.includes(h));
  let lIdx = header.findIndex((h) => LOC_KEYS.includes(h));
  let startAt = 1;                                  // skip the header row

  if (sIdx === -1 && lIdx === -1) {                 // no header row at all
    sIdx = 0; lIdx = 1; startAt = 0;
  } else {
    if (sIdx === -1) sIdx = (lIdx === 0) ? 1 : 0;
    if (lIdx === -1) lIdx = (sIdx === 0) ? 1 : 0;
  }

  const out = [];
  for (let i = startAt; i < grid.length; i++) {
    const searchText = (grid[i][sIdx] || '').trim();
    const location   = (grid[i][lIdx] || '').trim();
    if (!searchText && !location) continue;         // ignore blank lines
    out.push({ searchText, location });
  }
  return out;
}

/* =====================================================================
 * 2. FILE HANDLING (click + drag & drop)
 * =================================================================== */
fileDrop.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileDrop.classList.add('drag');
});
fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('drag'));
fileDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDrop.classList.remove('drag');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

function handleFile(file) {
  const reader = new FileReader();

  reader.onerror = () => setStatus('Could not read that file.', 'err');
  reader.onload  = () => applyCSV(String(reader.result), file.name);

  reader.readAsText(file);
}

/**
 * Load CSV text (from an upload or the bundled input.csv) into the UI.
 * @param {string} text raw CSV
 * @param {string} label shown under the Input CSV button
 * @param {string} [note] appended to the ready message, e.g. the source
 * @returns {boolean} whether any usable row was found
 */
function applyCSV(text, label, note) {
  try {
    parsedRows = rowsToJobs(parseCSV(text));

    if (!parsedRows.length) {
      startBtn.disabled = true;
      setStatus('No usable rows found in ' + label + '.', 'err');
      return false;
    }

    // Badges: how many distinct keywords / locations were supplied.
    const kw  = new Set(parsedRows.map((r) => r.searchText.toLowerCase()).filter(Boolean));
    const loc = new Set(parsedRows.map((r) => r.location.toLowerCase()).filter(Boolean));
    $('bKw').textContent  = kw.size;
    $('bLoc').textContent = loc.size;

    // Row range defaults to the whole file.
    startRowEl.value = 1;
    endRowEl.value   = parsedRows.length;
    startRowEl.max   = parsedRows.length;
    endRowEl.max     = parsedRows.length;

    fileName.textContent = label + ' — ' + parsedRows.length + ' row(s)';
    startBtn.disabled = false;
    refreshInputCount();
    setStatus('Ready: ' + parsedRows.length + ' search(es) loaded' + (note || '') + '.', 'ok');

    // Preview the first rows so the parse can be sanity-checked.
    logEl.textContent = '';
    parsedRows.slice(0, 4).forEach((r, i) => {
      addLog((i + 1) + '. "' + r.searchText + '" @ ' + (r.location || 'any'));
    });
    if (parsedRows.length > 4) addLog('… +' + (parsedRows.length - 4) + ' more');
    return true;
  } catch (err) {
    setStatus('CSV parse error: ' + err.message, 'err');
    return false;
  }
}

/* ---------------------------------------------------------------------
 * Default input: if the user uploads nothing, fall back to input.csv
 * shipped inside the extension folder. Editing that file and reopening
 * the popup is then enough to change the queue — no upload needed.
 * ------------------------------------------------------------------- */
function loadBundledCSV() {
  fetch(chrome.runtime.getURL(BUNDLED_CSV))
    .then((res) => {
      if (!res.ok) throw new Error('not found');
      return res.text();
    })
    .then((text) => {
      if (parsedRows.length) return;         // an upload already won
      applyCSV(text, BUNDLED_CSV, ' from the extension folder');
    })
    .catch(() => {
      // No bundled file — the popup simply waits for an upload.
      fileName.textContent = 'Columns: Search_Text, Location';
    });
}

/* =====================================================================
 * 3. OPTION WIRING
 * =================================================================== */

/** Pagination count only applies in multi-page mode. */
modeSel.addEventListener('change', () => {
  const multi = modeSel.value === 'multi';
  maxPagesEl.disabled = !multi;
  pillPages.classList.toggle('off', !multi);
  if (multi && Number(maxPagesEl.value) < 2) maxPagesEl.value = 3;
  if (!multi) maxPagesEl.value = 1;
});

/** The rows actually queued = the START..END slice of the CSV. */
function selectedRows() {
  const total = parsedRows.length;
  if (!total) return [];
  let s = Math.max(1, Math.min(total, parseInt(startRowEl.value, 10) || 1));
  let e = Math.max(1, Math.min(total, parseInt(endRowEl.value, 10) || total));
  if (e < s) e = s;
  return parsedRows.slice(s - 1, e);
}

function refreshInputCount() {
  const n = selectedRows().length;
  $('cInput').textContent = n;
  $('pTotal').textContent = n;
}
startRowEl.addEventListener('input', refreshInputCount);
endRowEl.addEventListener('input', refreshInputCount);

/* =====================================================================
 * 4. START / STOP / DOWNLOAD / CLEAR
 * =================================================================== */
startBtn.addEventListener('click', () => {
  const rows = selectedRows();
  if (!rows.length) { setStatus('Nothing in that row range.', 'err'); return; }

  const minDelay = Math.max(0.5, parseFloat(minDelayEl.value) || 2) * 1000;

  chrome.runtime.sendMessage({
    type: 'START_SCRAPE',
    payload: {
      rows: rows,
      maxPages: modeSel.value === 'multi'
        ? Math.max(1, parseInt(maxPagesEl.value, 10) || 1)
        : 1,
      minDelay: minDelay,
      maxDelay: minDelay + 2000,        // "2-4 seconds" style human jitter
      backgroundTab: bgTabEl.checked
    }
  }, (res) => {
    if (chrome.runtime.lastError) {
      setStatus('Background worker unreachable — reload the extension.', 'err');
      return;
    }
    if (res && res.ok) {
      logEl.textContent = '';
      lockUI(true);
      setStatus('Starting…');
    } else {
      setStatus((res && res.error) || 'Could not start.', 'err');
    }
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SCRAPE' }, () => void chrome.runtime.lastError);
  setStatus('Stopping after the current step…');
  stopBtn.disabled = true;
});

/** Re-export whatever is already stored, without re-scraping. */
downloadBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_NOW' }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res && res.ok) setStatus('Saved ' + res.filename, 'ok');
    else setStatus((res && res.error) || 'Nothing to download.', 'err');
  });
});

clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, (res) => {
    if (chrome.runtime.lastError) return;
    if (!res || !res.ok) return;
    logEl.textContent = '';
    render({ jobCount: 0, doneRows: 0, errorRows: 0, currentRow: 0, running: false, hasData: false });
    setStatus('Stored data cleared.', '');
  });
});

function lockUI(running) {
  const hasRows = parsedRows.length > 0;
  startBtn.disabled   = running || !hasRows;
  stopBtn.disabled    = !running;
  fileInput.disabled  = running;
  modeSel.disabled    = running;
  minDelayEl.disabled = running;
  startRowEl.disabled = running;
  endRowEl.disabled   = running;
  bgTabEl.disabled    = running;
  maxPagesEl.disabled = running || modeSel.value !== 'multi';
  $('pState').textContent = running ? 'Running' : 'Stopped';
}

/* =====================================================================
 * 5. LIVE PROGRESS FROM background.js
 * =================================================================== */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'PROGRESS') return;
  render(msg.payload);
});

function render(p) {
  if (!p) return;

  if (p.message) setStatus(p.message, p.level || '');
  if (p.log) addLog(p.log);

  const done   = num(p.doneRows);
  const errors = num(p.errorRows);
  const total  = num(p.totalRows) || Number($('pTotal').textContent) || 0;

  if (typeof p.totalRows === 'number') {
    $('cInput').textContent = p.totalRows;
    $('pTotal').textContent = p.totalRows;
  }
  if (typeof p.doneRows  === 'number') { $('cDone').textContent = done; $('pDone').textContent = done; }
  if (typeof p.errorRows === 'number')   $('cErrors').textContent = errors;
  if (typeof p.jobCount  === 'number')   $('cJobs').textContent = p.jobCount;

  // Blue bar = rows attempted; segmented bar = done / error / pending.
  if (total > 0) {
    const attempted = Math.min(total, done + errors);
    $('bar').style.width     = (attempted / total * 100) + '%';
    $('segDone').style.width = (done   / total * 100) + '%';
    $('segErr').style.width  = (errors / total * 100) + '%';
  }

  if (typeof p.running === 'boolean') {
    lockUI(p.running);
    if (!p.running && p.done) $('pState').textContent = 'Done';
  }

  const hasData = (typeof p.hasData === 'boolean') ? p.hasData : num(p.jobCount) > 0;
  downloadBtn.disabled = !hasData;
  clearBtn.disabled    = !hasData;
}

const num = (v) => (typeof v === 'number' ? v : 0);

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

function addLog(line) {
  logEl.textContent += (logEl.textContent ? '\n' : '') + line;
  logEl.scrollTop = logEl.scrollHeight;   // keep the newest line visible
}

/* ---------------------------------------------------------------------
 * On popup open, re-sync with background.js. The popup is destroyed every
 * time it closes, so the service worker holds the truth.
 * ------------------------------------------------------------------- */
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
  if (chrome.runtime.lastError || !state) { loadBundledCSV(); return; }

  if (state.running) {
    parsedRows = state.rows || [];
    fileName.textContent = 'Run in progress — ' + state.totalRows + ' row(s)';
    (state.logLines || []).forEach(addLog);
  } else if (state.lastSummary) {
    setStatus(state.lastSummary, 'ok');
  }
  render(Object.assign({}, state, { message: state.running ? state.message : '' }));

  if (!state.running) loadBundledCSV();
});
