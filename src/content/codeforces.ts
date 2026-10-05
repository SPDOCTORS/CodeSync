// Codeforces accepted-submission detector — browser runtime only.
// Phase 3: detects Accepted rows, extracts source code, queues submissions for GitHub sync.
// Do not scrape credentials or submit code to any external endpoint here.

import {
  isAcceptedRow,
  isSubmissionsPage,
  rowDataFromElement,
  sourceCodeFromHtml,
  submissionFromRowData,
} from './codeforces-adapter';
import { getProblemRating } from '../lib/codeforces-rating';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Submission IDs processed (or in-flight) in this page session. Prevents duplicate fetches. */
const observed = new Set<string>();

/**
 * Fetches the source code for a submission by loading its detail page.
 * Uses same-origin credentials so the logged-in session is forwarded.
 * Returns null if the page is unavailable or contains no parseable source block.
 */
async function fetchSource(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) return null;
    const html = await response.text();
    return sourceCodeFromHtml(html);
  } catch {
    return null;
  }
}

/**
 * Full pipeline for a single accepted submission row:
 *   1. Parse row metadata (IDs, URLs, language, timestamp).
 *   2. Fetch source code from the submission detail page.
 *   3. Build a complete Submission object.
 *   4. Send CODESYNC_QUEUE_SUBMISSION to the background service worker.
 *
 * If source is unavailable the ID is removed from `observed` so the next
 * DOM-mutation scan can retry (e.g. after the source becomes public).
 */
async function processRow(row: Element): Promise<void> {
  const data = rowDataFromElement(row, window.location.origin);
  if (!data) return;

  if (observed.has(data.submissionId)) return;
  observed.add(data.submissionId);

  // Brief delay before fetch: avoids hitting Codeforces immediately after page load.
  await sleep(300);

  const sourceCode = await fetchSource(data.submissionUrl);
  if (!sourceCode) {
    // Source unavailable — remove from observed so a later scan can retry.
    observed.delete(data.submissionId);
    return;
  }

  const rating = await getProblemRating(data.contestId, data.problemId);
  const submission = submissionFromRowData(data, sourceCode, rating);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CODESYNC_QUEUE_SUBMISSION',
      submission,
    }) as { queued?: boolean; reason?: string } | undefined;

    // If the background says already committed/queued, keep it in observed (no retry needed).
    if (!response?.queued &&
        response?.reason !== 'Already committed to GitHub.' &&
        response?.reason !== 'Already queued for GitHub.') {
      // Queue rejected for an unexpected reason — allow retry on next scan.
      observed.delete(data.submissionId);
    }
  } catch {
    // Service worker restarting — remove so the next scan can re-attempt.
    observed.delete(data.submissionId);
  }
}

/** Scans all submission tables on the current page for new Accepted rows. */
function scanPage(): void {
  if (!isSubmissionsPage(window.location.pathname)) return;

  const tables = document.querySelectorAll(
    '.status-frame-datatable, table.submissions-table, #pageContent table'
  );

  for (const table of Array.from(tables)) {
    // Collect rows from both modern (data-attribute) and older (tbody) layouts.
    const modern = Array.from(table.querySelectorAll<HTMLElement>('tr[data-submission-id], tr.highlighted'));
    const legacy = Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody tr'));
    const rows: Element[] = [...modern, ...legacy];

    // Deduplicate: a row may appear in both selectors on some pages.
    const seen = new Set<Element>();
    for (const row of rows) {
      if (seen.has(row)) continue;
      seen.add(row);
      if (!isAcceptedRow(row)) continue;
      void processRow(row);
    }
  }
}

/** Debounced scanner — avoids burst re-scans during live verdict updates. */
let scanScheduled = false;
function scheduleScan(): void {
  if (!scanScheduled) {
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanPage();
    }, 400);
  }
}

// Observe DOM mutations (Codeforces updates verdict cells in-place after judging).
new MutationObserver(scheduleScan).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// Handle SPA-style navigation.
for (const method of ['pushState', 'replaceState'] as const) {
  const original = history[method];
  history[method] = function (...args) {
    const result = original.apply(this, args);
    observed.clear(); // new page — reset session deduplication
    scheduleScan();
    return result;
  };
}
window.addEventListener('popstate', () => {
  observed.clear();
  scheduleScan();
});

// Respond to background readiness probe (mirrors CODESYNC_LEETCODE_READY pattern).
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type: unknown }).type === 'CODESYNC_CODEFORCES_READY'
  ) {
    sendResponse({ ok: true, adapter: 'codeforces' });
    return false;
  }
  return false;
});

// Initial scan on script load.
scheduleScan();
