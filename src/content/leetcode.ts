import {
  detailFromGraphql,
  extractProblemSlug,
  extractSubmissionIdFromUrl,
  hasSourceCode,
  historyPageFromResponse,
  isAcceptedHistoryRecord,
  isPending,
  parseLatestAcceptedSubmissionId,
  submissionFromDetail,
  type LeetCodeDetail,
  type TopicTag,
} from './leetcode-adapter';

const API_DELAY_MS = 750;
const MAX_VERDICT_POLLS = 12;
const HISTORY_PAGE_SIZE = 20;
const observed = new Set<string>();
let importing = false;
let lastInspectedSlug = '';
let lastInspectedTime = 0;

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const leetCodeUrl = (path: string) => new URL(path, window.location.origin).toString();
async function json(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(leetCodeUrl(path), { credentials: 'same-origin', ...init });
  if (!response.ok) throw new Error(`LeetCode returned ${response.status} for ${path}`);
  return response.json() as Promise<Record<string, unknown>>;
}
async function detailFor(submissionId: string): Promise<{ detail: LeetCodeDetail; topicTags: TopicTag[] | undefined }> {
  // This is the same-origin GraphQL data shape used by LeetCode's submission-detail UI.
  // It replaces the REST /submissions/detail/<id>/ endpoint, which may reject extension fetches with 403.
  const result = await json('/graphql/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query submissionDetails($submissionId: Int!) { submissionDetails(submissionId: $submissionId) { id code timestamp statusCode lang { name verboseName } question { questionId title titleSlug topicTags { name slug } } } }', variables: { submissionId: Number(submissionId) } }) });
  const data = result.data as { submissionDetails?: Record<string, unknown> } | undefined;
  if (!data?.submissionDetails) throw new Error('LeetCode did not return accessible submission details for this submission.');
  return detailFromGraphql(data.submissionDetails);
}
function detailIdFromPage(): string | null {
  // 1. Standalone URL path: /submissions/detail/<id>
  const fromPath = extractSubmissionIdFromUrl(window.location.pathname);
  if (fromPath) return fromPath;

  // 2. Query param or hash if present
  const queryParam = new URLSearchParams(window.location.search).get('submissionId');
  if (queryParam && /^\d+$/.test(queryParam)) return queryParam;

  // 3. Anchor in modern result pane pointing to submission details
  const link = document.querySelector<HTMLAnchorElement>('a[href*="/submissions/detail/"]');
  if (link?.href) {
    const fromLink = extractSubmissionIdFromUrl(link.href);
    if (fromLink) return fromLink;
  }

  return null;
}

/**
 * Checks if the current page DOM displays an 'Accepted' verdict in the submission result view.
 */
function hasAcceptedVerdictInDom(): boolean {
  // Modern LeetCode displays 'Accepted' in a dedicated verdict element, tab header, or data locator
  const elements = Array.from(
    document.querySelectorAll(
      '[data-e2e-locator="submission-result"], [class*="result"], [data-headline], [class*="status"]'
    )
  );
  for (const el of elements) {
    const text = el.textContent?.trim();
    if (text === 'Accepted' || (text?.startsWith('Accepted') && text.length < 30)) {
      return true;
    }
  }
  return false;
}

/**
 * Queries LeetCode GraphQL for the most recent submission on this question.
 */
async function latestAcceptedSubmissionId(questionSlug: string): Promise<string | null> {
  try {
    const query = `query submissionList($offset: Int!, $limit: Int!, $lastKey: String, $questionSlug: String!) {
      submissionList(offset: $offset, limit: $limit, lastKey: $lastKey, questionSlug: $questionSlug) {
        submissions {
          id
          statusDisplay
        }
      }
    }`;
    const result = await json('/graphql/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { questionSlug, offset: 0, limit: 1 } }),
    });
    return parseLatestAcceptedSubmissionId(result);
  } catch {
    return null;
  }
}

type QueueOutcome = 'queued' | 'already-synchronized' | 'missing-source' | 'skipped' | 'queue-failed';
type ImportCounters = { totalRecords: number; acceptedIdentified: number; alreadySynchronized: number; missingSourceCode: number; inaccessibleOrSkipped: number; successfullyQueued: number; failedQueueOperations: number };
const emptyCounters = (): ImportCounters => ({ totalRecords: 0, acceptedIdentified: 0, alreadySynchronized: 0, missingSourceCode: 0, inaccessibleOrSkipped: 0, successfullyQueued: 0, failedQueueOperations: 0 });
function importSummary(counters: ImportCounters): string {
  if (counters.totalRecords === 0) return 'LeetCode history import complete: no accessible submission records were returned.';
  if (counters.acceptedIdentified === 0) return `LeetCode history import complete: ${counters.totalRecords} records returned; none were Accepted.`;
  return `LeetCode history import complete: ${counters.totalRecords} records, ${counters.acceptedIdentified} Accepted, ${counters.successfullyQueued} queued, ${counters.alreadySynchronized} already synchronized, ${counters.missingSourceCode} missing source, ${counters.inaccessibleOrSkipped} inaccessible or skipped, ${counters.failedQueueOperations} queue failures.`;
}
async function queueAccepted(submissionId: string): Promise<QueueOutcome> {
  if (observed.has(submissionId)) return 'already-synchronized';
  observed.add(submissionId);
  try {
    let result = await detailFor(submissionId);
    for (let attempt = 0; isPending(result.detail) && attempt < MAX_VERDICT_POLLS; attempt += 1) { await sleep(1500); result = await detailFor(submissionId); }
    const submission = submissionFromDetail(result.detail, result.topicTags);
    if (!hasSourceCode(result.detail)) return 'missing-source';
    if (!submission) return 'skipped';
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CODESYNC_QUEUE_SUBMISSION', submission }) as { queued?: boolean; reason?: string } | undefined;
      if (response?.queued) return 'queued';
      if (response?.reason === 'Already committed to GitHub.' || response?.reason === 'Already queued for GitHub.') return 'already-synchronized';
      return 'queue-failed';
    } catch { return 'queue-failed'; }
  } catch (error) {
    observed.delete(submissionId);
    throw error;
  }
}
async function historyProgress(message: string, pending: number, state: 'syncing' | 'idle' | 'error' = 'syncing'): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'CODESYNC_HISTORY_PROGRESS', platform: 'LeetCode', message, pending, state }).catch(() => undefined);
}
async function reportError(message: string): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'CODESYNC_LEETCODE_ERROR', message }).catch(() => undefined);
}
async function inspectPage(): Promise<void> {
  // Only the active detail route is automatic. Listing old submissions requires the explicit import action.
  // 1. Classic detail route or DOM link
  let id = detailIdFromPage();

  // 2. Modern problem page with Accepted verdict in DOM
  const slug = extractProblemSlug(window.location.pathname);
  if (!id && slug && hasAcceptedVerdictInDom()) {
    const now = Date.now();
    // Debounce GraphQL check per slug (at most once every 3 seconds per problem page)
    if (slug !== lastInspectedSlug || now - lastInspectedTime > 3000) {
      lastInspectedSlug = slug;
      lastInspectedTime = now;
      id = await latestAcceptedSubmissionId(slug);
    }
  }

  if (!id) return;
  try { await queueAccepted(id); } catch (error) { await reportError(`LeetCode submission ${id} could not be inspected: ${error instanceof Error ? error.message : 'Unknown error'}`); }
}
async function importHistory(): Promise<{ ok: boolean; message: string }> {
  if (importing) return { ok: false, message: 'A LeetCode history import is already running.' };
  importing = true; let offset = 0; let lastKey = ''; const counters = emptyCounters(); const pageSignatures = new Set<string>();
  try {
    while (true) {
      const query = new URLSearchParams({ offset: String(offset), limit: String(HISTORY_PAGE_SIZE) }); if (lastKey) query.set('lastkey', lastKey);
      const page = await json(`/api/submissions/?${query}`);
      const { rows, nextKey } = historyPageFromResponse(page);
      if (!rows.length) break;
      const signature = rows.map(row => String(row.id ?? row.submission_id ?? '')).join(','); if (signature && pageSignatures.has(signature)) break; pageSignatures.add(signature);
      counters.totalRecords += rows.length;
      for (const row of rows) {
        const id = String(row.id ?? row.submission_id ?? '');
        if (!id || !isAcceptedHistoryRecord(row)) continue;
        counters.acceptedIdentified += 1;
        try {
          const outcome = await queueAccepted(id);
          if (outcome === 'queued') counters.successfullyQueued += 1;
          else if (outcome === 'already-synchronized') counters.alreadySynchronized += 1;
          else if (outcome === 'missing-source') counters.missingSourceCode += 1;
          else if (outcome === 'queue-failed') counters.failedQueueOperations += 1;
          else counters.inaccessibleOrSkipped += 1;
        } catch { counters.inaccessibleOrSkipped += 1; }
        await historyProgress(`LeetCode history: ${counters.totalRecords} records; ${counters.acceptedIdentified} Accepted; ${counters.successfullyQueued} queued; ${counters.alreadySynchronized} already synchronized.`, counters.successfullyQueued);
        await sleep(API_DELAY_MS);
      }
      if (nextKey && nextKey !== lastKey) { lastKey = nextKey; offset += rows.length; await sleep(API_DELAY_MS); continue; }
      if (rows.length < HISTORY_PAGE_SIZE) break;
      lastKey = ''; offset += rows.length; await sleep(API_DELAY_MS);
    }
    const summary = importSummary(counters); await historyProgress(summary, counters.successfullyQueued, 'idle');
    return { ok: true, message: summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown LeetCode import error';
    await historyProgress(`LeetCode history import failed: ${message}`, counters.successfullyQueued, 'error');
    return { ok: false, message: `LeetCode history import failed: ${message}` };
  } finally { importing = false; }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'CODESYNC_LEETCODE_READY') { sendResponse({ ok: true, adapter: 'leetcode' }); return false; }
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'CODESYNC_IMPORT_LEETCODE_HISTORY') { void importHistory().then(sendResponse); return true; }
  return false;
});

let scheduled = false;
function scheduleInspection() { if (!scheduled) { scheduled = true; setTimeout(() => { scheduled = false; void inspectPage(); }, 350); } }
new MutationObserver(scheduleInspection).observe(document.documentElement, { childList: true, subtree: true });
for (const method of ['pushState', 'replaceState'] as const) { const original = history[method]; history[method] = function (...args) { const result = original.apply(this, args); scheduleInspection(); return result; }; }
window.addEventListener('popstate', scheduleInspection); scheduleInspection();
