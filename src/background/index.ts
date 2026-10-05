import { DEFAULT_SETTINGS, DEFAULT_SYNC_STATUS, type Settings, type Submission } from '../lib/types';
import { normalizeAuthorizationServer } from '../lib/github';
import { GitHubRequestError, githubService, normalizeRepository } from '../lib/github';
import { enqueueAcceptedSubmission, processQueue, repairQueueLanguages, retryFailedSubmissions, runConnectionTest } from './sync';
Object.assign(globalThis, { repairQueueLanguages });

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get('settings');
  if (!current.settings) await chrome.storage.local.set({settings: DEFAULT_SETTINGS, syncStatus: DEFAULT_SYNC_STATUS});
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'codesync-retry') void processQueue(); });
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'CODESYNC_PING') {
    void chrome.storage.local.get('settings').then(({settings}) => {
      sendResponse({ok: true, enabled: (settings as Settings | undefined)?.enabled ?? true, platformUrl: sender.tab?.url ?? null});
    });
    return true;
  }
  if (typeof message === 'object' && message !== null && 'type' in message) {
    const typed = message as { type: string; submission?: Submission; settings?: Settings; repository?: string; authorizationServer?: string };
    if (typed.type === 'CODESYNC_SAVE_SETTINGS' && typed.settings) { void saveSettings(typed.settings).then(sendResponse).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })); return true; }
    if (typed.type === 'CODESYNC_SAVE_AUTHORIZATION_SERVER' && typeof typed.authorizationServer === 'string') { void saveAuthorizationServer(typed.authorizationServer).then(sendResponse).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })); return true; }
    if (typed.type === 'CODESYNC_QUEUE_SUBMISSION' && typed.submission) { void enqueueAcceptedSubmission(typed.submission).then(sendResponse); return true; }
    if (typed.type === 'CODESYNC_RETRY_NOW') { void processQueue().then(() => sendResponse({ ok: true })); return true; }
    if (typed.type === 'CODESYNC_RETRY_FAILED_SUBMISSIONS') { void retryFailedSubmissions().then(result => sendResponse(result)).catch(error => sendResponse({ ok: false, message: error instanceof Error ? error.message : String(error) })); return true; }
    if (typed.type === 'CODESYNC_REPAIR_CF_LANGUAGES' && typeof (message as Record<string, unknown>)['languages'] === 'object') { const langs = ((message as unknown) as { languages: Record<string, string> }).languages; void repairQueueLanguages(langs).then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })); return true; }
    if (typed.type === 'CODESYNC_AUTH') { void authorize().then(sendResponse).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })); return true; }
    if (typed.type === 'CODESYNC_AUTH_STATUS') { void checkAuthentication().then(sendResponse).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })); return true; }
    if (typed.type === 'CODESYNC_LIST_REPOSITORIES') { void repositories().then(sendResponse).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })); return true; }
    if (typed.type === 'CODESYNC_VERIFY_REPOSITORY' && typeof typed.repository === 'string') { void verifyRepository(typed.repository).then(sendResponse).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })); return true; }
    if (typed.type === 'CODESYNC_CREATE_REPOSITORY') { void createRepository().then(sendResponse).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })); return true; }
    if (typed.type === 'CODESYNC_TEST_GITHUB_COMMIT') { void runConnectionTest().then(result => sendResponse({ ok: result.ok, message: result.message })).catch(error => sendResponse({ ok: false, message: error instanceof Error ? error.message : String(error) })); return true; }
    if (typed.type === 'CODESYNC_IMPORT_LEETCODE_HISTORY') { void importLeetCodeHistory().then(sendResponse).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })); return true; }
    if (typed.type === 'CODESYNC_HISTORY_PROGRESS') { const update = message as { message?: unknown; pending?: unknown; state?: unknown }; const state = update.state === 'idle' || update.state === 'error' ? update.state : 'syncing'; void chrome.storage.local.set({ syncStatus: { state, message: typeof update.message === 'string' ? update.message : 'LeetCode history import is running.', pending: typeof update.pending === 'number' ? update.pending : 0 } }); sendResponse({ ok: true }); return true; }
    if (typed.type === 'CODESYNC_LEETCODE_ERROR') { const update = message as { message?: unknown }; void chrome.storage.local.set({ syncStatus: { state: 'error', message: typeof update.message === 'string' ? update.message : 'LeetCode synchronization failed.', pending: 0 } }); sendResponse({ ok: true }); return true; }
  }
  return false;
});

async function authorize(): Promise<{ ok: boolean; error?: string; message?: string }> {
  const { settings } = await chrome.storage.local.get('settings') as { settings?: Settings };
  const baseUrl = normalizeAuthorizationServer(settings?.authorizationServer ?? '');
  if (!baseUrl) return { ok: false, error: 'Enter an HTTPS backend URL, or http://localhost:8787 for local development.' };
  const origin = `${baseUrl}/*`;
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) return { ok: false, error: 'Allow access to the selected authorization server in Settings, then try again.' };
  const redirectUri = chrome.identity.getRedirectURL('github');
  const state = crypto.randomUUID();
  await chrome.storage.session.set({ oauthState: state });
  const result = await chrome.identity.launchWebAuthFlow({ url: `${baseUrl}/v1/oauth/github/start?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`, interactive: true });
  if (!result) return { ok: false, error: 'GitHub authorization was cancelled.' };
  const url = new URL(result); const returnedState = url.searchParams.get('state'); const code = url.searchParams.get('code');
  const saved = await chrome.storage.session.get('oauthState');
  if (!code || returnedState !== saved.oauthState) return { ok: false, error: 'Authorization response could not be verified.' };
  const exchange = await fetch(`${baseUrl}/v1/oauth/github/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, redirect_uri: redirectUri }) });
  if (!exchange.ok) return { ok: false, error: `The authorization server rejected the sign-in response (${exchange.status}): ${(await exchange.text()).slice(0, 300)}` };
  const payload = await exchange.json() as { sessionToken?: unknown };
  if (typeof payload.sessionToken !== 'string') return { ok: false, error: 'The authorization server returned no session.' };
  await chrome.storage.session.set({ backendSession: payload.sessionToken });
  await chrome.storage.session.remove('oauthState');
  if (settings?.repository) {
    try {
      const verification = await verifyRepository(settings.repository);
      if (!verification.ok) return { ok: true, message: `GitHub connected, but ${settings.repository} still needs verification: ${verification.error}` };
      await chrome.storage.local.set({ settings: { ...settings, repository: verification.repository } });
      await processQueue();
      return { ok: true, message: `GitHub connected. Verified ${verification.repository}.` };
    } catch (error) {
      return { ok: true, message: `GitHub connected, but ${settings.repository} could not be verified: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  await chrome.storage.local.set({ syncStatus: { state: 'idle', message: 'GitHub connected. Choose a repository.', pending: 0 } });
  return { ok: true, message: 'GitHub connected. Choose a repository.' };
}

async function saveAuthorizationServer(value: string): Promise<{ ok: boolean; authorizationServer?: string; error?: string }> {
  const authorizationServer = normalizeAuthorizationServer(value);
  if (!authorizationServer) return { ok: false, error: 'Use an HTTPS backend URL, or http://localhost:8787 for local development.' };
  const { settings } = await chrome.storage.local.get('settings') as { settings?: Settings };
  await chrome.storage.local.set({ settings: { ...(settings ?? DEFAULT_SETTINGS), authorizationServer } });
  return { ok: true, authorizationServer };
}

async function checkAuthentication(): Promise<{ ok: boolean; authenticated: boolean; message?: string }> {
  const stored = await chrome.storage.local.get(['settings', 'syncStatus']) as { settings?: Settings; syncStatus?: typeof DEFAULT_SYNC_STATUS };
  const service = stored.settings && await githubService(stored.settings);
  if (!service) return { ok: true, authenticated: false, message: 'GitHub is not connected.' };
  try {
    await service.checkSession();
    return { ok: true, authenticated: true };
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 401) {
      await chrome.storage.session.remove('backendSession');
      await processQueue();
      return { ok: true, authenticated: false, message: 'GitHub session expired after the backend restarted. Sign in again; queued submissions are preserved.' };
    }
    const message = `Could not confirm the GitHub session: ${error instanceof Error ? error.message : 'Unknown error'}`;
    await chrome.storage.local.set({ syncStatus: { ...(stored.syncStatus ?? DEFAULT_SYNC_STATUS), state: 'error', message } });
    return { ok: false, authenticated: true, message };
  }
}

async function importLeetCodeHistory(): Promise<{ ok: boolean; error?: string; message?: string }> {
  const { settings } = await chrome.storage.local.get('settings') as { settings?: Settings };
  if (!settings?.importHistory) return { ok: false, error: 'Enable and save historical import in Settings before starting a LeetCode import.' };
  const tabs = await chrome.tabs.query({ url: ['https://leetcode.com/*', 'https://www.leetcode.com/*'] });
  const tab = tabs.find(candidate => candidate.active && candidate.id != null) ?? tabs.find(candidate => candidate.id != null);
  if (!tab?.id || !isLeetCodeTab(tab.url)) return { ok: false, error: 'Open leetcode.com or www.leetcode.com in a signed-in browser tab, then try again.' };
  const ready = await ensureLeetCodeAdapter(tab.id, tab.url);
  if (!ready.ok) return { ok: false, error: ready.error };
  let response: { ok?: boolean; message?: string } | undefined;
  try { response = await chrome.tabs.sendMessage(tab.id, { type: 'CODESYNC_IMPORT_LEETCODE_HISTORY' }) as { ok?: boolean; message?: string } | undefined; }
  catch (error) { return { ok: false, error: `The LeetCode adapter stopped responding: ${error instanceof Error ? error.message : String(error)}. Refresh the LeetCode tab and try again.` }; }
  if (!response) return { ok: false, error: 'The LeetCode adapter returned no import response. Refresh the LeetCode tab and try again.' };
  return response.ok ? { ok: true, message: response.message } : { ok: false, error: response.message ?? 'LeetCode history import failed.' };
}

function isLeetCodeTab(url: string | undefined): boolean {
  try { const parsed = new URL(url ?? ''); return parsed.protocol === 'https:' && (parsed.hostname === 'leetcode.com' || parsed.hostname === 'www.leetcode.com'); }
  catch { return false; }
}
async function adapterReady(tabId: number): Promise<boolean> {
  try { const response = await chrome.tabs.sendMessage(tabId, { type: 'CODESYNC_LEETCODE_READY' }) as { ok?: boolean; adapter?: string } | undefined; return response?.ok === true && response.adapter === 'leetcode'; }
  catch { return false; }
}
async function ensureLeetCodeAdapter(tabId: number, url: string | undefined): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isLeetCodeTab(url)) return { ok: false, error: 'The selected tab is not a supported LeetCode page.' };
  if (await adapterReady(tabId)) return { ok: true };
  try {
    // Tabs open before an extension reload do not receive manifest content scripts until reload; inject only our packaged adapter into this permitted LeetCode tab.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['assets/leetcode.js'] });
  } catch (error) { return { ok: false, error: `CodeSync could not attach its LeetCode adapter: ${error instanceof Error ? error.message : String(error)}. Refresh the LeetCode tab and try again.` }; }
  if (await adapterReady(tabId)) return { ok: true };
  return { ok: false, error: 'CodeSync could not reach the LeetCode adapter after attaching it. Refresh the LeetCode tab and try again.' };
}

async function repositories(): Promise<{ ok: true; repositories: Array<{ full_name: string; private: boolean }> } | { ok: false; error: string }> {
  const { settings } = await chrome.storage.local.get('settings') as { settings?: Settings };
  const service = settings && await githubService(settings);
  if (!service) return { ok: false, error: 'Sign in with GitHub first.' };
  return { ok: true, repositories: await service.listRepositories() };
}
async function verifyRepository(value: string): Promise<{ ok: true; repository: string } | { ok: false; error: string }> {
  const repository = normalizeRepository(value);
  if (!repository) return { ok: false, error: 'Use owner/repo or a github.com repository URL.' };
  const { settings } = await chrome.storage.local.get('settings') as { settings?: Settings };
  const service = settings && await githubService(settings);
  if (!service) return { ok: false, error: 'Sign in with GitHub first.' };
  const verified = await service.verifyRepository(repository);
  const normalized = normalizeRepository(verified.full_name);
  return normalized ? { ok: true, repository: normalized } : { ok: false, error: 'GitHub returned an invalid repository.' };
}
async function createRepository(): Promise<{ ok: true; repository: string } | { ok: false; error: string }> {
  const { settings } = await chrome.storage.local.get('settings') as { settings?: Settings };
  const service = settings && await githubService(settings);
  if (!service) return { ok: false, error: 'Sign in with GitHub first.' };
  const created = await service.createRepository(); const repository = normalizeRepository(created.full_name);
  if (!repository) return { ok: false, error: 'The authorization server returned an invalid repository.' };
  await chrome.storage.local.set({ settings: { ...settings, repository } }); await processQueue();
  return { ok: true, repository };
}
async function saveSettings(settings: Settings): Promise<{ ok: boolean; repository?: string; error?: string }> {
  const repository = settings.repository ? normalizeRepository(settings.repository) : '';
  if (settings.repository && !repository) return { ok: false, error: 'Use owner/repo or a GitHub repository URL.' };
  const next = { ...settings, repository: repository ?? '' };
  if (next.repository) {
    const verification = await verifyRepository(next.repository);
    if (!verification.ok) return verification;
    next.repository = verification.repository;
  }
  await chrome.storage.local.set({ settings: next }); await processQueue();
  return { ok: true, repository: next.repository };
}
