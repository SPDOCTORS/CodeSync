import { githubService } from '../lib/github';
import { pathFor, submissionKey } from '../lib/paths';
import { DEFAULT_SYNC_STATUS, type QueueItem, type Settings, type Submission, type SyncDiagnostic, type SyncStatus } from '../lib/types';
import { getProblemRating } from '../lib/codeforces-rating';

const QUEUE_KEY = 'syncQueue'; const STATUS_KEY = 'syncStatus'; const COMPLETED_KEY = 'completedSubmissionKeys'; const DIAGNOSTICS_KEY = 'syncDiagnostics';
const MAX_ATTEMPTS = 5; const MAX_DIAGNOSTICS = 100;
const CONNECTION_TEST_PATH = 'CodeSync-Tests/connection-test.txt'; const CONNECTION_TEST_CONTENT = 'CodeSync GitHub integration test'; const CONNECTION_TEST_KEY = 'completedConnectionTests';
let processing: Promise<void> | null = null;
async function state() { const stored = await chrome.storage.local.get([QUEUE_KEY, STATUS_KEY, COMPLETED_KEY, 'settings']); return { queue: (stored[QUEUE_KEY] as QueueItem[] | undefined) ?? [], completed: new Set((stored[COMPLETED_KEY] as string[] | undefined) ?? []), settings: stored.settings as Settings }; }
async function diagnostic(entry: Omit<SyncDiagnostic, 'at'>) { const stored = await chrome.storage.local.get(DIAGNOSTICS_KEY); const next = [...((stored[DIAGNOSTICS_KEY] as SyncDiagnostic[] | undefined) ?? []), { ...entry, at: new Date().toISOString() }].slice(-MAX_DIAGNOSTICS); await chrome.storage.local.set({ [DIAGNOSTICS_KEY]: next }); }
function counts(queue: QueueItem[], completed: Set<string>) { return { pending: queue.filter(item => !item.permanentlyFailed && item.attempts === 0).length, retrying: queue.filter(item => !item.permanentlyFailed && item.attempts > 0).length, committed: completed.size, permanentlyFailed: queue.filter(item => item.permanentlyFailed).length }; }
async function status(queue: QueueItem[], completed: Set<string>, state: SyncStatus['state'], message: string, latestGitHubError?: string) { const metrics = counts(queue, completed); await chrome.storage.local.set({ [STATUS_KEY]: { state, message, pending: metrics.pending + metrics.retrying, counts: metrics, latestGitHubError } satisfies SyncStatus }); }

let enqueuing: Promise<unknown> = Promise.resolve();

export async function enqueueAcceptedSubmission(submission: Submission): Promise<{ queued: boolean; reason?: string }> {
  if (submission.verdict !== 'accepted') return { queued: false, reason: 'Only Accepted submissions are synchronized.' };
  const run = async () => {
    const current = await state(); const key = submissionKey(submission);
    if (current.completed.has(key)) return { queued: false, reason: 'Already committed to GitHub.' };
    if (current.queue.some(item => submissionKey(item.submission) === key)) return { queued: false, reason: 'Already queued for GitHub.' };
    current.queue.push({ submission, attempts: 0, nextAttemptAt: Date.now() }); await chrome.storage.local.set({ [QUEUE_KEY]: current.queue });
    await diagnostic({ stage: 'enqueued', submissionKey: key, message: 'Accepted submission added to the durable GitHub queue.' });
    return { queued: true };
  };
  const task = enqueuing.then(run, run);
  enqueuing = task;
  const result = (await task) as { queued: boolean; reason?: string };
  if (result.queued) {
    void processQueue();
  }
  return result;
}


export function processQueue(): Promise<void> { if (!processing) processing = process().finally(() => { processing = null; }); return processing; }
async function process(): Promise<void> {
  const current = await state(); let queue = current.queue; const completed = current.completed; const settings = current.settings;
  const active = queue.find(item => !item.permanentlyFailed && item.nextAttemptAt <= Date.now());
  const service = settings && await githubService(settings);
  if (!settings?.enabled || !settings?.repository || !service) { const message = !service ? 'GitHub session is missing or expired. Sign in again; queued submissions are preserved.' : 'Select a GitHub repository to synchronize.'; await diagnostic({ stage: 'session-missing', message }); await status(queue, completed, 'error', message, !service ? 'GitHub session is missing or expired.' : undefined); return; }
  while (active || queue.some(item => !item.permanentlyFailed && item.nextAttemptAt <= Date.now())) {
    const item = queue.find(candidate => !candidate.permanentlyFailed && candidate.nextAttemptAt <= Date.now()); if (!item) break;
    const key = submissionKey(item.submission); await diagnostic({ stage: 'commit-attempt', submissionKey: key, message: `Sending commit to ${settings.repository}.` }); await status(queue, completed, 'syncing', 'Synchronizing queued submissions…');
    try {
      const s = item.submission;
      if (s.platform === 'codeforces' && s.rating == null && s.contest) {
        const rating = await getProblemRating(s.contest, s.problemId);
        if (typeof rating === 'number') s.rating = rating;
      }
      await service.commit(settings.repository, pathFor(s), s.sourceCode, `Accepted: ${s.platform} — ${s.problemTitle} (${s.language}, #${s.submissionId})`);
      completed.add(key);
      const fresh = await state();
      queue = fresh.queue.filter(candidate => submissionKey(candidate.submission) !== key);
      await chrome.storage.local.set({ [QUEUE_KEY]: queue, [COMPLETED_KEY]: [...completed] });
      await diagnostic({ stage: 'commit-confirmed', submissionKey: key, message: 'GitHub confirmed the file commit.' });
    }
    catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown GitHub API error';
      const fresh = await state();
      const target = fresh.queue.find(candidate => submissionKey(candidate.submission) === key) ?? item;
      target.attempts += 1;
      target.lastError = message;
      if (target.attempts >= MAX_ATTEMPTS) {
        item.permanentlyFailed = true;
        target.permanentlyFailed = true;
        await diagnostic({ stage: 'permanently-failed', submissionKey: key, message });
      } else {
        target.nextAttemptAt = Date.now() + 2 ** target.attempts * 30_000;
        await diagnostic({ stage: 'retry-scheduled', submissionKey: key, message });
      }
      queue = fresh.queue;
      await chrome.storage.local.set({ [QUEUE_KEY]: queue, [COMPLETED_KEY]: [...completed] });
      await status(queue, completed, target.permanentlyFailed ? 'error' : 'retrying', target.permanentlyFailed ? 'A GitHub commit permanently failed. Use Retry failed submissions.' : 'GitHub commit failed; retrying automatically.', message);
      const next = queue.find(candidate => !candidate.permanentlyFailed);
      if (next?.nextAttemptAt) chrome.alarms.create('codesync-retry', { when: next.nextAttemptAt });
      return;
    }
  }
  const fresh = await state();
  queue = fresh.queue.filter(candidate => !completed.has(submissionKey(candidate.submission)));
  await chrome.storage.local.set({ [QUEUE_KEY]: queue, [COMPLETED_KEY]: [...completed] });
  await status(queue, completed, 'idle', 'GitHub queue is up to date.');
}

export async function retryFailedSubmissions(): Promise<{ ok: boolean; message: string }> { const current = await state(); const failed = current.queue.filter(item => item.permanentlyFailed); if (!failed.length) return { ok: false, message: 'There are no permanently failed submissions to retry.' }; failed.forEach(item => { item.permanentlyFailed = false; item.attempts = 0; item.lastError = undefined; item.nextAttemptAt = Date.now(); }); await chrome.storage.local.set({ [QUEUE_KEY]: current.queue }); await processQueue(); return { ok: true, message: `Retrying ${failed.length} failed submission${failed.length === 1 ? '' : 's'}.` }; }

export async function runConnectionTest(): Promise<{ ok: boolean; message: string }> {
  const current = await state();
  const service = await githubService(current.settings);
  if (!service) return { ok: false, message: 'Sign in with GitHub before running the connection test.' };
  let repository = current.settings?.repository?.trim();
  if (!repository) {
    try {
      const repos = await service.listRepositories();
      const defaultRepo = repos.find(r => /(?:^|\/)Competitive-Programming$/i.test(r.full_name))?.full_name ?? repos[0]?.full_name;
      if (defaultRepo) repository = defaultRepo;
    } catch {
      // ignore repository listing error
    }
  }
  if (!repository) return { ok: false, message: 'Set or select a GitHub repository before running the connection test.' };
  const previous = new Set((await chrome.storage.local.get(CONNECTION_TEST_KEY))[CONNECTION_TEST_KEY] as string[] | undefined ?? []);
  if (previous.has(repository)) return { ok: false, message: 'This browser has already created the GitHub connection test commit for this repository.' };
  try { // No SHA is supplied, so GitHub rejects an existing file rather than overwriting it.
    await service.commit(repository, CONNECTION_TEST_PATH, CONNECTION_TEST_CONTENT, 'CodeSync: GitHub connection test');
    previous.add(repository);
    await chrome.storage.local.set({ [CONNECTION_TEST_KEY]: [...previous] });
    return { ok: true, message: 'GitHub connection test commit created.' };
  } catch (error) {
    return { ok: false, message: `GitHub connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}

/**
 * Pure function: applies a submissionId→language map to a queue snapshot.
 * Only patches Codeforces items whose language is currently 'Unknown'.
 * Returns an immutable-style new queue array (items are shallow-cloned),
 * the count of repaired items, and a per-ID detail map.
 * Has no side-effects — safe to call in tests without a Chrome environment.
 */
export function applyLanguageRepairs(
  queue: QueueItem[],
  languageMap: Record<string, string>,
): { queue: QueueItem[]; repaired: number; details: Record<string, string> } {
  let repaired = 0;
  const details: Record<string, string> = {};
  const updated = queue.map(item => {
    if (item.submission.platform !== 'codeforces') return item;
    if (item.submission.language !== 'Unknown') return item;
    const lang = languageMap[item.submission.submissionId];
    if (!lang || lang === 'Unknown') return item;
    repaired++;
    details[item.submission.submissionId] = lang;
    return { ...item, submission: { ...item.submission, language: lang } };
  });
  return { queue: updated, repaired, details };
}

/**
 * Reads the live syncQueue from chrome.storage.local, applies language repairs
 * for Codeforces items with language 'Unknown', and writes the patched queue
 * back to storage.
 *
 * Intentionally does NOT call processQueue() — the caller decides when to commit.
 * Returns the same shape as applyLanguageRepairs for reporting.
 */
export async function repairQueueLanguages(
  languageMap: Record<string, string>,
): Promise<{ repaired: number; details: Record<string, string> }> {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const raw = (stored[QUEUE_KEY] as QueueItem[] | undefined) ?? [];
  const result = applyLanguageRepairs(raw, languageMap);
  if (result.repaired > 0) {
    await chrome.storage.local.set({ [QUEUE_KEY]: result.queue });
  }
  return { repaired: result.repaired, details: result.details };
}

