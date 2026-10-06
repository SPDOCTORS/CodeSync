// CodeChef accepted-submission detector — browser runtime only.
// Detects Accepted rows on the logged-in user's profile Recent Activity table,
// extracts source code, and queues submissions for GitHub sync.
// Do not scrape credentials or submit code to any external endpoint here.

import {
  extractLoggedInUsername,
  fetchSubmissionSource,
  isAcceptedRow,
  isProfilePage,
  parseSubmissionRow,
  profileUsernameFromPath,
  submissionFromRowData,
} from './codechef-adapter';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Submission IDs processed (or in-flight) in this page session. Prevents duplicate fetches. */
const observed = new Set<string>();

/**
 * Full pipeline for a single accepted submission row:
 *   1. Parse row metadata (IDs, URLs, language, timestamp).
 *   2. Fetch source code from /api/submission-code/<id>.
 *   3. Build a complete Submission object.
 *   4. Send CODESYNC_QUEUE_SUBMISSION to the background service worker.
 */
async function processRow(row: Element): Promise<void> {
  const data = parseSubmissionRow(row, window.location.origin);
  if (!data || !data.isAccepted) return;

  if (observed.has(data.submissionId)) return;
  observed.add(data.submissionId);

  // Brief delay before fetch: avoids hitting CodeChef immediately after DOM insertion.
  await sleep(300);

  const result = await fetchSubmissionSource(data.submissionId, {
    origin: window.location.origin,
  });

  if (!result || !result.code) {
    // Source unavailable — remove from observed so a later scan can retry.
    observed.delete(data.submissionId);
    return;
  }

  const submission = submissionFromRowData(data, result.code);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CODESYNC_QUEUE_SUBMISSION',
      submission,
    }) as { queued?: boolean; reason?: string } | undefined;

    // If the background says already committed/queued, keep it in observed (no retry needed).
    if (
      !response?.queued &&
      response?.reason !== 'Already committed to GitHub.' &&
      response?.reason !== 'Already queued for GitHub.'
    ) {
      // Queue rejected for an unexpected reason — allow retry on next scan.
      observed.delete(data.submissionId);
    }
  } catch {
    // Service worker restarting — remove so the next scan can re-attempt.
    observed.delete(data.submissionId);
  }
}

/** Scans the Recent Activity table on the logged-in user's profile for new Accepted rows. */
function scanPage(): void {
  if (!isProfilePage(window.location.pathname)) return;

  const profileUser = profileUsernameFromPath(window.location.pathname);
  if (!profileUser) return;

  const loggedInUser = extractLoggedInUsername(document, window);
  // Only process if this is the logged-in user's own profile page
  if (!loggedInUser || loggedInUser.toLowerCase() !== profileUser.toLowerCase()) return;

  const rows = document.querySelectorAll(
    '#rankContentDiv table.dataTable tbody tr, .recent-activity table.dataTable tbody tr, #rankContentDiv table tbody tr, table.dataTable tbody tr'
  );

  const seen = new Set<Element>();
  for (const row of Array.from(rows)) {
    if (seen.has(row)) continue;
    seen.add(row);
    if (!isAcceptedRow(row)) continue;
    void processRow(row);
  }
}

/** Debounced scanner — handles dynamically loaded Recent Activity table mutations. */
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

// Observe DOM mutations (CodeChef loads Recent Activity asynchronously via AJAX).
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

// Respond to background readiness probe.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type: unknown }).type === 'CODESYNC_CODECHEF_READY'
  ) {
    sendResponse({ ok: true, adapter: 'codechef' });
    return false;
  }
  return false;
});

// Startup ping to background service worker.
chrome.runtime.sendMessage({ type: 'CODESYNC_PING', platform: 'codechef' }).catch(() => {});

// Initial scan on script load.
scheduleScan();
