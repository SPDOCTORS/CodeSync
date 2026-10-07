import { useEffect, useState } from 'react';
import { normalizeAuthorizationServer, normalizeRepository } from '../lib/github';
import { DEFAULT_SETTINGS, DEFAULT_SYNC_STATUS, type Settings, type SyncStatus } from '../lib/types';
import '../popup/style.css';

type Reply = { ok: boolean; error?: string; message?: string; repository?: string; authorizationServer?: string; authenticated?: boolean; repositories?: Array<{ full_name: string; private: boolean }> };
type RepositoryLoadState = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';
function isReply(value: unknown): value is Reply { return typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean'; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
async function send(type: string, payload: Record<string, unknown> = {}): Promise<Reply> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type, ...payload });
    if (!isReply(response)) return { ok: false, error: 'CommitFlow did not receive a response from its service worker. Reload the extension and try again.' };
    return response;
  } catch (error) { return { ok: false, error: `Could not contact CommitFlow: ${errorMessage(error)}` }; }
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [repos, setRepos] = useState<Array<{ full_name: string; private: boolean }>>([]);
  const [repositoryLoadState, setRepositoryLoadState] = useState<RepositoryLoadState>('idle');
  const [repositoryLoadError, setRepositoryLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(DEFAULT_SYNC_STATUS);
  const [testingCommit, setTestingCommit] = useState(false);
  const [importingHistory, setImportingHistory] = useState(false);
  const isLocalDevelopment = normalizeAuthorizationServer(settings.authorizationServer) === 'http://localhost:8787';
  useEffect(() => { void chrome.storage.local.get(['settings', 'syncStatus']).then(data => { setSettings(data.settings ?? DEFAULT_SETTINGS); setSyncStatus(data.syncStatus ?? DEFAULT_SYNC_STATUS); }).catch(error => setNotice(`Could not load settings: ${errorMessage(error)}`)); void send('CODESYNC_AUTH_STATUS'); const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => { if (area === 'local' && changes.syncStatus?.newValue) setSyncStatus(changes.syncStatus.newValue as SyncStatus); }; chrome.storage.onChanged.addListener(onChanged); return () => chrome.storage.onChanged.removeListener(onChanged); }, []);
  async function save(candidate: Settings = settings): Promise<Settings | null> {
    const repository = candidate.repository ? normalizeRepository(candidate.repository) : ''; const authorizationServer = candidate.authorizationServer ? normalizeAuthorizationServer(candidate.authorizationServer) : '';
    if (candidate.repository && !repository) { setNotice('Use owner/repo or a github.com repository URL.'); return null; }
    if (candidate.authorizationServer && !authorizationServer) { setNotice('Use an HTTPS backend URL, or http://localhost:8787 for local development.'); return null; }
    const next = { ...candidate, repository: repository ?? '', authorizationServer: authorizationServer ?? '' };
    try { const reply = await send('CODESYNC_SAVE_SETTINGS', { settings: next }); if (!reply.ok) { setNotice(reply.error ?? 'Could not save repository selection.'); return null; } const saved = { ...next, repository: reply.repository ?? next.repository }; setSettings(saved); setNotice(saved.repository ? `Using ${saved.repository}. Queue synchronization resumed.` : 'Saved locally.'); return saved; }
    catch (error) { setNotice(`Could not save settings: ${errorMessage(error)}`); return null; }
  }
  async function signIn() {
    const authorizationServer = normalizeAuthorizationServer(settings.authorizationServer);
    if (!authorizationServer) { setNotice('Enter an HTTPS backend URL, or http://localhost:8787 for local development.'); return; }
    const saved = await send('CODESYNC_SAVE_AUTHORIZATION_SERVER', { authorizationServer });
    if (!saved.ok) { setNotice(saved.error ?? 'Could not save the authorization server.'); return; }
    const next = { ...settings, authorizationServer: saved.authorizationServer ?? authorizationServer }; setSettings(next);
    try {
      // This must run in the settings page's click handler: Chrome permission prompts require a user gesture.
      const granted = await chrome.permissions.request({ origins: [`${next.authorizationServer}/*`] });
      if (!granted) { setNotice('CommitFlow needs access to the selected authorization server to sign in.'); return; }
    } catch (error) { setNotice(`Chrome could not grant backend access: ${errorMessage(error)}`); return; }
    const reply = await send('CODESYNC_AUTH'); setNotice(reply.ok ? reply.message ?? 'GitHub connected.' : reply.error ?? 'Sign-in failed.');
  }
  async function loadRepos() {
    setRepositoryLoadState('loading'); setRepositoryLoadError(''); setRepos([]);
    const reply = await send('CODESYNC_LIST_REPOSITORIES');
    if (!reply.ok) { const error = reply.error ?? 'Could not load repositories.'; setRepositoryLoadState('error'); setRepositoryLoadError(error); setNotice(error); return; }
    const loaded = reply.repositories ?? []; setRepos(loaded); setRepositoryLoadState(loaded.length ? 'loaded' : 'empty'); setNotice(loaded.length ? 'Repositories loaded.' : 'No accessible repositories were returned. Enter owner/repo below to verify and use one directly.');
  }
  async function createRepo() {
    const reply = await send('CODESYNC_CREATE_REPOSITORY');
    if (reply.ok && reply.repository) await useRepository(reply.repository);
    else {
      const error = reply.error ?? 'Could not create repository.';
      const userPrefix = repos[0]?.full_name?.split('/')[0] || (settings.repository ? settings.repository.split('/')[0] : '') || 'owner';
      setNotice(/already exists|422/i.test(error) ? `Competitive-Programming already exists. Use Select existing or enter ${userPrefix}/Competitive-Programming below.` : error);
    }
  }
  async function useRepository(value = settings.repository) {
    const repository = normalizeRepository(value);
    if (!repository) { setNotice('Use owner/repo or a github.com repository URL.'); return; }
    setNotice(`Verifying access to ${repository}…`);
    const verified = await send('CODESYNC_VERIFY_REPOSITORY', { repository });
    if (!verified.ok || !verified.repository) { setNotice(verified.error ?? `GitHub could not verify access to ${repository}.`); return; }
    const next = { ...settings, repository: verified.repository }; setSettings(next); await save(next);
  }
  async function selectRepository(repository: string) { await useRepository(repository); }
  async function testGitHubCommit() { setTestingCommit(true); const reply = await send('CODESYNC_TEST_GITHUB_COMMIT'); setNotice(reply.message ?? reply.error ?? 'GitHub connection test failed.'); setTestingCommit(false); }
  async function importLeetCodeHistory() { const next = await save(); if (!next?.importHistory) { if (next) setNotice('Enable historical import before starting a LeetCode import.'); return; } setImportingHistory(true); const reply = await send('CODESYNC_IMPORT_LEETCODE_HISTORY'); setNotice(reply.message ?? reply.error ?? 'LeetCode history import failed.'); setImportingHistory(false); }
  return <main className="wide"><h1>CommitFlow settings</h1><p>GitHub authorization is completed by your configured backend. The extension never contains a GitHub secret or access token.</p>
    <section><label htmlFor="server">Authorization server</label><input id="server" value={settings.authorizationServer} placeholder="https://commitflow.example.com or http://localhost:8787" onChange={e => { setSettings({ ...settings, authorizationServer: e.target.value }); setNotice(''); }} /><button onClick={() => void signIn()}>Sign in with GitHub</button></section>
    <section><label htmlFor="repo">GitHub repository</label><input id="repo" value={settings.repository} placeholder="owner/Competitive-Programming or https://github.com/owner/repo" onChange={e => { setSettings({ ...settings, repository: e.target.value }); setNotice(''); }} /><div className="buttons"><button onClick={() => void useRepository()}>Use this repository</button><button onClick={() => void loadRepos()} disabled={repositoryLoadState === 'loading'}>{repositoryLoadState === 'loading' ? 'Loading repositories…' : 'Select existing'}</button><button onClick={() => void createRepo()}>Create Competitive-Programming</button></div>{repositoryLoadState === 'loaded' && <select aria-label="Existing repositories" value="" onChange={e => { if (e.target.value) void selectRepository(e.target.value); }}><option value="">Choose a repository…</option>{repos.map(repo => <option key={repo.full_name} value={repo.full_name}>{repo.full_name}{repo.private ? ' (private)' : ''}</option>)}</select>}{repositoryLoadState === 'empty' && <p role="status">No accessible repositories were returned. Enter an owner/repo value above and choose Use this repository.</p>}{repositoryLoadState === 'error' && <p role="alert">Could not load repositories: {repositoryLoadError}</p>}{isLocalDevelopment && <section><strong>Development only</strong><p>Creates one synthetic file in {settings.repository || 'the configured repository'}. It never touches solution folders.</p><button disabled={testingCommit} onClick={() => void testGitHubCommit()}>{testingCommit ? 'Testing GitHub…' : 'Test GitHub Commit'}</button></section>}<label><input type="checkbox" checked={settings.importHistory} onChange={e => { setSettings({ ...settings, importHistory: e.target.checked }); setNotice(''); }} /> Enable historical import from the signed-in LeetCode tab</label>{settings.importHistory && <button disabled={importingHistory} onClick={() => void importLeetCodeHistory()}>{importingHistory ? 'Importing LeetCode history…' : 'Import LeetCode history'}</button>}<button onClick={() => void save()}>Save settings</button>{notice && <p role="status">{notice}</p>}</section>
    <section><strong>Synchronization status</strong><p role="status">{syncStatus.message}</p>{syncStatus.pending > 0 && <p>{syncStatus.pending} submission{syncStatus.pending === 1 ? '' : 's'} queued for GitHub.</p>}</section>
    <section><strong>Submission capture</strong><p>Automatic synchronization is active for verified Accepted submissions across LeetCode, Codeforces, CodeChef, CSES, and AtCoder.</p></section>
  </main>;
}
