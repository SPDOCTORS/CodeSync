// AtCoder accepted-submission detector — browser runtime.
// On AtCoder submission-detail pages, detects accepted submissions, verifies ownership,
// builds the Submission payload, and sends it through the existing CodeSync queue.
// Do not scrape credentials or submit code to any external endpoint here.

import {
  isSubmissionResultPage,
  processSubmissionPage,
} from './atcoder-adapter';
import type { Submission } from '../lib/types';

/** Submission keys processed (or in-flight) in this page session. Prevents duplicate queues. */
const observed = new Set<string>();

/**
 * Sends an accepted AtCoder submission to the CodeSync background service worker queue.
 */
async function sendToQueue(
  submission: Submission,
): Promise<{ queued?: boolean; reason?: string } | undefined> {
  return chrome.runtime.sendMessage({
    type: 'CODESYNC_QUEUE_SUBMISSION',
    submission,
  }) as Promise<{ queued?: boolean; reason?: string } | undefined>;
}

/**
 * Scans the current page if it is an AtCoder submission detail page.
 */
async function scanPage(): Promise<void> {
  if (!isSubmissionResultPage(window.location.pathname)) return;

  try {
    await processSubmissionPage(document, {
      url: window.location.href,
      origin: window.location.origin,
      observed,
      queueFn: sendToQueue,
    });
  } catch {
    // Fail-safe: background worker restarting or temporary network hiccup
  }
}

/** Debounced scan runner to handle in-page grading / DOM mutations (WJ -> AC transition). */
let scanScheduled = false;
function scheduleScan(): void {
  if (!scanScheduled) {
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      void scanPage();
    }, 300);
  }
}

// Initial ping for status tracking
chrome.runtime.sendMessage({ type: 'CODESYNC_PING', platform: 'atcoder' }).catch(() => {
  // Service worker may be restarting
});

// Run initial scan on submission detail pages
if (isSubmissionResultPage(window.location.pathname)) {
  void scanPage();

  // Observe DOM for judging (WJ -> AC) transition
  const observer = new MutationObserver(() => {
    scheduleScan();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
