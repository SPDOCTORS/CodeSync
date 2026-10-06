// CSES accepted-submission detector — browser runtime.
// On CSES result pages, detects accepted submissions, resolves the topic,
// builds the Submission payload, and sends it through the existing CodeSync queue.
// Do not scrape credentials or submit code to any external endpoint here.

import {
  isResultPage,
  processResultPage,
  resolveProblemTopic,
} from './cses-adapter';
import type { Submission } from '../lib/types';

/** Submission IDs processed (or in-flight) in this page session. Prevents duplicate queues. */
const observed = new Set<string>();

/**
 * Sends an accepted CSES submission to the CodeSync background service worker queue.
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
 * Scans the current page if it is a CSES submission result page.
 */
async function scanPage(): Promise<void> {
  if (!isResultPage(window.location.pathname)) return;

  try {
    await processResultPage(document, {
      url: window.location.href,
      origin: window.location.origin,
      observed,
      queueFn: sendToQueue,
      resolveTopicFn: (problemId) =>
        resolveProblemTopic(problemId, { origin: window.location.origin }),
    });
  } catch {
    // Fail-safe: background worker restarting or temporary network hiccup
  }
}

/** Debounced scan runner to handle in-page grading / DOM mutations. */
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
chrome.runtime.sendMessage({ type: 'CODESYNC_PING', platform: 'cses' }).catch(() => {
  // Service worker may be restarting
});

// Run initial scan on result pages
if (isResultPage(window.location.pathname)) {
  void scanPage();

  // Observe DOM for testing -> ready transition
  const observer = new MutationObserver(() => {
    scheduleScan();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
