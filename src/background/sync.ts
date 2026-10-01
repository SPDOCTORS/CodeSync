import { githubService } from '../lib/github';
import { pathFor, submissionKey } from '../lib/paths';
import { DEFAULT_SYNC_STATUS, type QueueItem, type Settings, type Submission, type SyncDiagnostic, type SyncStatus } from '../lib/types';

const QUEUE_KEY = 'syncQueue'; const STATUS_KEY = 'syncStatus'; const COMPLETED_KEY = 'completedSubmissionKeys'; const DIAGNOSTICS_KEY = 'syncDiagnostics';
const MAX_ATTEMPTS = 5; const MAX_DIAGNOSTICS = 100;
const CONNECTION_TEST_REPOSITORY = 'SPDOCTORS/Competitive-Programming'; const CONNECTION_TEST_PATH = 'CodeSync-Tests/connection-test.txt'; const CONNECTION_TEST_CONTENT = 'CodeSync GitHub integration test'; const CONNECTION_TEST_KEY = 'completedConnectionTests';
let processing: Promise<void> | null = null;
async function state() { const stored = await chrome.storage.local.get([QUEUE_KEY, STATUS_KEY, COMPLETED_KEY, 'settings']); return { queue: (stored[QUEUE_KEY] as QueueItem[] | undefined) ?? [], completed: new Set((stored[COMPLETED_KEY] as string[] | undefined) ?? []), settings: stored.settings as Settings }; }
async function diagnostic(entry: Omit<SyncDiagnostic, 'at'>) { const stored = await chrome.storage.local.get(DIAGNOSTICS_KEY); const next = [...((stored[DIAGNOSTICS_KEY] as SyncDiagnostic[] | undefined) ?? []), { ...entry, at: new Date().toISOString() }].slice(-MAX_DIAGNOSTICS); await chrome.storage.local.set({ [DIAGNOSTICS_KEY]: next }); }
function counts(queue: QueueItem[], completed: Set<string>) { return { pending: queue.filter(item => !item.permanentlyFailed && item.attempts === 0).length, retrying: queue.filter(item => !item.permanentlyFailed && item.attempts > 0).length, committed: completed.size, permanentlyFailed: queue.filter(item => item.permanentlyFailed).length }; }
async function status(queue: QueueItem[], completed: Set<string>, state: SyncStatus['state'], message: string, latestGitHubError?: string) { const metrics = counts(queue, completed); await chrome.storage.local.set({ [STATUS_KEY]: { state, message, pending: metrics.pending + metrics.retrying, counts: metrics, latestGitHubError } satisfies SyncStatus }); }

export async function enqueueAcceptedSubmission(submission: Submission): Promise<{ queued: boolean; reason?: string }> {
  if (submission.verdict !== 'accepted') return { queued: false, reason: 'Only Accepted submissions are synchronized.' };
  const current = await state(); const key = submissionKey(submission);
  if (current.completed.has(key)) return { queued: false, reason: 'Already committed to GitHub.' };
  if (current.queue.some(item => submissionKey(item.submission) === key)) return { queued: false, reason: 'Already queued for GitHub.' };
  current.queue.push({ submission, attempts: 0, nextAttemptAt: Date.now() }); await chrome.storage.local.set({ [QUEUE_KEY]: current.queue });
  await diagnostic({ stage: 'enqueued', submissionKey: key, message: 'Accepted submission added to the durable GitHub queue.' }); await processQueue(); return { queued: true };
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
    try { const s = item.submission; await service.commit(settings.repository, pathFor(s), s.sourceCode, `Accepted: ${s.platform} — ${s.problemTitle} (${s.language}, #${s.submissionId})`); completed.add(key); queue = queue.filter(candidate => candidate !== item); await diagnostic({ stage: 'commit-confirmed', submissionKey: key, message: 'GitHub confirmed the file commit.' }); }
    catch (error) { const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown GitHub API error'; item.attempts += 1; item.lastError = message; if (item.attempts >= MAX_ATTEMPTS) { item.permanentlyFailed = true; await diagnostic({ stage: 'permanently-failed', submissionKey: key, message }); } else { item.nextAttemptAt = Date.now() + 2 ** item.attempts * 30_000; await diagnostic({ stage: 'retry-scheduled', submissionKey: key, message }); } await chrome.storage.local.set({ [QUEUE_KEY]: queue, [COMPLETED_KEY]: [...completed] }); await status(queue, completed, item.permanentlyFailed ? 'error' : 'retrying', item.permanentlyFailed ? 'A GitHub commit permanently failed. Use Retry failed submissions.' : 'GitHub commit failed; retrying automatically.', message); const next = queue.find(candidate => !candidate.permanentlyFailed); if (next?.nextAttemptAt) chrome.alarms.create('codesync-retry', { when: next.nextAttemptAt }); return; }
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: queue, [COMPLETED_KEY]: [...completed] }); await status(queue, completed, 'idle', 'GitHub queue is up to date.');
}

export async function retryFailedSubmissions(): Promise<{ ok: boolean; message: string }> { const current = await state(); const failed = current.queue.filter(item => item.permanentlyFailed); if (!failed.length) return { ok: false, message: 'There are no permanently failed submissions to retry.' }; failed.forEach(item => { item.permanentlyFailed = false; item.attempts = 0; item.lastError = undefined; item.nextAttemptAt = Date.now(); }); await chrome.storage.local.set({ [QUEUE_KEY]: current.queue }); await processQueue(); return { ok: true, message: `Retrying ${failed.length} failed submission${failed.length === 1 ? '' : 's'}.` }; }

export async function runConnectionTest(): Promise<{ ok: boolean; message: string }> {
  const current = await state(); const repository = current.settings?.repository;
  if (repository?.toLowerCase() !== CONNECTION_TEST_REPOSITORY.toLowerCase()) return { ok: false, message: `Set the repository to ${CONNECTION_TEST_REPOSITORY} before running the connection test.` };
  const previous = new Set((await chrome.storage.local.get(CONNECTION_TEST_KEY))[CONNECTION_TEST_KEY] as string[] | undefined ?? []); if (previous.has(repository)) return { ok: false, message: 'This browser has already created the GitHub connection test commit for this repository.' };
  const service = await githubService(current.settings); if (!service) return { ok: false, message: 'Sign in with GitHub before running the connection test.' };
  try { // No SHA is supplied, so GitHub rejects an existing file rather than overwriting it.
    await service.commit(repository, CONNECTION_TEST_PATH, CONNECTION_TEST_CONTENT, 'CodeSync: GitHub connection test'); previous.add(repository); await chrome.storage.local.set({ [CONNECTION_TEST_KEY]: [...previous] }); return { ok: true, message: 'GitHub connection test commit created.' }; }
  catch (error) { return { ok: false, message: `GitHub connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}` }; }
}
