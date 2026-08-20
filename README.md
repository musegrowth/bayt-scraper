# Bayt Job Scraper — Chrome Extension (Manifest V3)

Bulk-search [bayt.com](https://www.bayt.com/) from a CSV and export every job listing it finds to a new CSV.

Upload a two-column CSV (`Search_Text`, `Location`), press **Scrape Bayt**, and the extension drives a real
browser tab through each search — typing the keyword, picking the country from the autocomplete, clicking
**Find jobs**, then reading every job card on the results page.

---

## Install

1. Open `chrome://extensions/`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Pin the extension and click its icon to open the popup

---

## Input CSV

```csv
Search_Text,Location
Software Engineer,Bahrain
Graphic Designer,United Arab Emirates
Accountant,Saudi Arabia
```

* Header names are matched loosely — `Search_Text`, `search text`, `keyword`, `query`, `job title` all work,
  as do `Location`, `country`, `city`, `region`. Column order does not matter.
* No header at all? Column 1 is treated as the search text, column 2 as the location.
* Leave `Location` blank to search **all locations**; leave `Search_Text` blank to list every job in a country.
* Quoted fields, embedded commas, `""` escapes, CRLF and a UTF-8 BOM are all handled.

### Just Scrape — no CSV

Pick **Just Scrape — Current Page** when you have already searched on Bayt yourself and simply want the
results exported. Open the results page, press **Scrape Bayt**, and the extension reads that page — no typing,
no navigation, no CSV. The `Search_Text` / `Search_Location` columns are filled from the page's own search box
so the export still shows what the jobs were a search for.

Set **Pagination** above 1 to keep walking on from there. If no Bayt tab is open the run stops with
*"Open a Bayt results page first"* rather than opening one and guessing what you wanted.

### Default input file

If you start a run **without uploading anything**, the extension reads **`input.csv` from its own folder**.
Edit that file, reopen the popup, and the new rows are picked up — no upload step. Uploading a file always
overrides it for that session.

---

## Popup controls

| Control | What it does |
| --- | --- |
| **Scrape Mode** | *First Page* — one page per CSV row. *Multi Page* — several pages per CSV row. *Just Scrape* — no CSV at all: reads the Bayt page you already have open. |
| **Input CSV** | Choose a file, or drag one onto the button. `KW` / `LOC` show how many distinct keywords and locations were parsed. |
| **Pagination** | Pages per search (Multi Page mode only). |
| **Delay (sec)** | Minimum pause between actions; the actual pause is randomised between this and +2 s. |
| **Start / End** | Run only a slice of the CSV — handy for resuming a long file. |
| **Run in a background tab** | Keeps the automated tab unfocused so you can work in another tab. |
| **Download** | Re-export everything collected so far, without re-scraping. |
| **Clear Data** | Wipe the stored results. |

The counters mirror the run: **Input** (rows queued), **Done**, **Stored** (jobs captured), **Errors** (rows that failed).
The popup is only a view — closing it does not stop the run.

---

## Output CSV

Downloads automatically when the queue finishes, as `bayt-jobs-<timestamp>.csv`:

| Column | Notes |
| --- | --- |
| `Search_Text`, `Search_Location` | Echoed from your input row |
| `Job_Title`, `Job_URL` | Title text and the absolute link to the posting |
| `Company` | From the company link on the card (`/en/company/…`) |
| `Job_Location` | From the card's metadata row, e.g. `Dubai, UAE` |
| `Career_Level` | e.g. `Mid career` |
| `Experience` | e.g. `4-10 Years of Experience` |
| `Remote` | `Yes` / `No`, derived from the metadata row |
| `Other_Info` | Every other fact the card shows, `\|`-joined — job type, and anything Bayt adds later |
| `Summary` | Bayt's AI summary, with the `✨ Summary:` prefix stripped |
| `Job_Date` | e.g. `6 days ago` |
| `Result_Page`, `Scraped_At` | Which page it came from, ISO timestamp |

Any field missing from a card is written as `N/A` rather than aborting the row.
The file starts with a UTF-8 BOM so Excel opens Arabic company names correctly.

---

## How it works

```
popup.js ──rows──► background.js ──inject──► content.js ──► bayt.com DOM
   ▲                    │                        │
   └──── progress ──────┘◄──── scraped jobs ─────┘
```

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: `activeTab`, `scripting`, `storage`, `downloads`, `tabs` + `bayt.com` host permissions |
| `input.csv` | Default search list, used when nothing is uploaded |
| `popup.html` / `popup.js` | UI, CSV parsing (no CDN — MV3's CSP blocks remote scripts, so PapaParse is replaced by a built-in RFC-4180 parser), progress rendering |
| `background.js` | Service worker: owns the queue, drives the tab, injects the content script, builds and downloads the CSV |
| `content.js` | All page interaction: fill search, pick location, submit, scrape |

Per row: navigate to `bayt.com/en/` → type keyword → type location and click the matching suggestion →
click **Find jobs** → wait for the results page → scrape → optional extra pages.

### Behaviour worth knowing

* **Existing tab is reused.** If a bayt.com tab is already open (or is your active tab), it is driven directly
  instead of opening a new one. Only if none exists is a tab created.
* **Searches run from wherever you are.** The quick-search widget sits in the header of results pages too, so
  after the first search each row is typed straight into the page already on screen — no return trip to the home
  page. Rows with a blank keyword *or* a blank location are the exception: those start from the home page, whose
  widget is clean, so the previous row's value cannot linger in the field nothing is typed over.
* **Human-ish pacing.** Typing is per-character with jitter; pauses between steps are randomised (default 2–4 s).
* **Cookie banner** ("We value your privacy") is dismissed automatically when present.
* **Two autocompletes.** `#text_search` has its own suggestion list using the *same* `a[data-highlight]` markup
  as the country list, so it is closed before the location field is touched, and location matches are geometrically
  scoped to the dropdown under `#search_country__r`.
* **Direct-URL fallback.** If the widget fails or no country suggestion matches, the run falls back to Bayt's
  canonical URL — `https://www.bayt.com/en/<country>/jobs/<keyword>-jobs/` — instead of searching the wrong place.
* **Real pagination links.** Multi-page mode reads the next page's URL from the `#pagination` strip
  (`<a class="jsAjaxLoad" href="…?page=2">`) instead of guessing, so any filters already in the URL are kept,
  and a page that isn't linked ends the loop rather than being requested blindly.
* **Failures are per-row.** A row that errors increments the **Errors** counter and the run continues.
* **Crash-safe.** Results are mirrored to `chrome.storage` after every step, so a service-worker restart does
  not lose data — use **Download** to export it.

---

## Maintaining the selectors

Bayt changes its markup from time to time. **Every selector lives in one place:** the `SEL` object at the top of
`content.js`. Each entry is a list — the first selector that matches wins — with the original XPaths kept in `XP`
as a last-resort fallback.

```js
const SEL = {
  searchInput:   '#text_search',
  locationInput: '#search_country__r',
  submitButton:  '#submitButtonQuickSearchWidget',
  jobCards:        ['#results_inner_card ul li[data-js-job]', /* … */],
  cardTitle:       ['h2 a', 'a[data-js-aid="jobID"]', 'h2'],
  cardCompany:     ['a[href*="/company/"]', /* … */],
  cardMeta:        ['dl.dlist', 'dl'],          // location / career level / remote
  metaLocation:    'dt[class*="jb-label-location"]',
  metaCareerLevel: 'dt[class*="jb-label-careerlevel"]',
  paginationLinks: ['#pagination a[href]', /* … */],
  // …
};
```

If a run reports `no job cards found`, open a results page, inspect a card, and add the new class to the matching
list. Nothing else in the codebase hard-codes a selector.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Location dropdown did not match "X"` | The country name must match Bayt's own list (e.g. `United Arab Emirates`, not `UAE`). The run still continues via the direct URL. |
| `no job cards found` | Either the search genuinely returned nothing, or the card markup changed — update `SEL.jobCards`. |
| `Content script did not respond` | Reload the extension at `chrome://extensions/`. |
| Nothing downloads | Check Chrome's download settings; the file is written without a Save-As prompt. |
| Run stalls | Increase **Delay (sec)** — Bayt throttles rapid requests. |

---

## Notes

Scrapes only what a signed-out visitor can already see, at a deliberately human pace. Keep the delay reasonable
and respect Bayt's terms of use.
