import { useEffect, useState } from 'react';
import { normalizeAuthorizationServer, normalizeRepository } from '../lib/github';
import { DEFAULT_SETTINGS, DEFAULT_SYNC_STATUS, type Settings, type SyncStatus } from '../lib/types';
import './style.css';

type Reply = {
  ok: boolean;
  error?: string;
  message?: string;
  repository?: string;
  authorizationServer?: string;
  authenticated?: boolean;
  repositories?: Array<{ full_name: string; private: boolean }>;
};
type RepositoryLoadState = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

function isReply(value: unknown): value is Reply {
  return typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean';
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
async function send(type: string, payload: Record<string, unknown> = {}): Promise<Reply> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type, ...payload });
    if (!isReply(response)) return { ok: false, error: 'Service worker unavailable. Reload extension.' };
    return response;
  } catch (error) {
    return { ok: false, error: `Could not contact CommitFlow: ${errorMessage(error)}` };
  }
}



function CommitFlowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="6" cy="18" r="3" fill="#10b981" stroke="#059669" strokeWidth="1.5" />
      <circle cx="18" cy="6" r="3" fill="#10b981" stroke="#059669" strokeWidth="1.5" />
      <path d="M6 15V9a3 3 0 0 1 3-3h6" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M12 9l3-3-3-3" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<SyncStatus>(DEFAULT_SYNC_STATUS);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [repos, setRepos] = useState<Array<{ full_name: string; private: boolean }>>([]);
  const [repoLoadState, setRepoLoadState] = useState<RepositoryLoadState>('idle');
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [customRepo, setCustomRepo] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void chrome.storage.local.get(['settings', 'syncStatus', 'backendSession']).then(data => {
      setSettings(data.settings ?? DEFAULT_SETTINGS);
      setStatus(data.syncStatus ?? DEFAULT_SYNC_STATUS);
      if (data.backendSession) setAuthenticated(true);
      else setAuthenticated(false);
    });

    void chrome.runtime.sendMessage({ type: 'CODESYNC_AUTH_STATUS' }).then((reply: unknown) => {
      if (isReply(reply) && reply.authenticated !== undefined) setAuthenticated(reply.authenticated);
    }).catch(() => undefined);

    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local') {
        if (changes.settings?.newValue) setSettings(changes.settings.newValue as Settings);
        if (changes.syncStatus?.newValue) setStatus(changes.syncStatus.newValue as SyncStatus);
        if (changes.backendSession) setAuthenticated(Boolean(changes.backendSession.newValue));
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  async function toggle() {
    const next = { ...settings, enabled: !settings.enabled };
    setSettings(next);
    await chrome.storage.local.set({ settings: next });
  }

  async function retry() {
    await chrome.runtime.sendMessage({ type: 'CODESYNC_RETRY_NOW' });
    const { syncStatus } = await chrome.storage.local.get('syncStatus');
    setStatus(syncStatus ?? DEFAULT_SYNC_STATUS);
  }

  async function retryFailed() {
    await chrome.runtime.sendMessage({ type: 'CODESYNC_RETRY_FAILED_SUBMISSIONS' });
    const { syncStatus } = await chrome.storage.local.get('syncStatus');
    setStatus(syncStatus ?? DEFAULT_SYNC_STATUS);
  }

  async function signIn() {
    setNotice('Connecting GitHub…');
    const authorizationServer = normalizeAuthorizationServer(settings.authorizationServer) || 'https://code-sync-rho-brown.vercel.app';
    const saved = await send('CODESYNC_SAVE_AUTHORIZATION_SERVER', { authorizationServer });
    if (!saved.ok) { setNotice(saved.error ?? 'Could not save authorization server.'); return; }
    try {
      const granted = await chrome.permissions.request({ origins: [`${authorizationServer}/*`] });
      if (!granted) { setNotice('Permission denied for authorization server.'); return; }
    } catch (error) {
      setNotice(`Permission error: ${errorMessage(error)}`);
      return;
    }
    const reply = await send('CODESYNC_AUTH');
    if (reply.ok) {
      setAuthenticated(true);
      setNotice(reply.message ?? 'GitHub connected.');
      void loadRepos();
    } else {
      setNotice(reply.error ?? 'Sign-in failed.');
    }
  }

  async function loadRepos() {
    setRepoLoadState('loading');
    setRepos([]);
    const reply = await send('CODESYNC_LIST_REPOSITORIES');
    if (!reply.ok) {
      setRepoLoadState('error');
      setNotice(reply.error ?? 'Could not load repositories.');
      return;
    }
    const loaded = reply.repositories ?? [];
    setRepos(loaded);
    setRepoLoadState(loaded.length ? 'loaded' : 'empty');
  }

  async function save(candidate: Settings = settings): Promise<Settings | null> {
    const repository = candidate.repository ? normalizeRepository(candidate.repository) : '';
    const authorizationServer = candidate.authorizationServer ? normalizeAuthorizationServer(candidate.authorizationServer) : '';
    const next = { ...candidate, repository: repository ?? '', authorizationServer: authorizationServer ?? '' };
    try {
      const reply = await send('CODESYNC_SAVE_SETTINGS', { settings: next });
      if (!reply.ok) { setNotice(reply.error ?? 'Could not save settings.'); return null; }
      const saved = { ...next, repository: reply.repository ?? next.repository };
      setSettings(saved);
      return saved;
    } catch (error) {
      setNotice(`Could not save settings: ${errorMessage(error)}`);
      return null;
    }
  }

  async function useRepository(value: string) {
    const repository = normalizeRepository(value);
    if (!repository) { setNotice('Use owner/repo format.'); return; }
    setNotice(`Verifying access to ${repository}…`);
    const verified = await send('CODESYNC_VERIFY_REPOSITORY', { repository });
    if (!verified.ok || !verified.repository) {
      setNotice(verified.error ?? `Could not verify access to ${repository}.`);
      return;
    }
    const next = { ...settings, repository: verified.repository };
    setSettings(next);
    await save(next);
    setShowRepoPicker(false);
    setNotice(`Using ${verified.repository}`);
  }

  async function createRepo() {
    setNotice('Creating Competitive-Programming repo…');
    const reply = await send('CODESYNC_CREATE_REPOSITORY');
    if (reply.ok && reply.repository) {
      await useRepository(reply.repository);
    } else {
      const error = reply.error ?? 'Could not create repository.';
      const userPrefix = repos[0]?.full_name?.split('/')[0] || (settings.repository ? settings.repository.split('/')[0] : '') || 'owner';
      setNotice(/already exists|422/i.test(error) ? `Repository exists. Select existing or enter ${userPrefix}/Competitive-Programming.` : error);
    }
  }

  const counts = status.counts ?? { pending: status.pending, retrying: 0, committed: 0, permanentlyFailed: 0 };

  const platforms = [
    { name: 'LeetCode', id: 'leetcode' },
    { name: 'Codeforces', id: 'codeforces' },
    { name: 'CodeChef', id: 'codechef' },
    { name: 'CSES', id: 'cses' },
    { name: 'AtCoder', id: 'atcoder' },
  ];

  if (!authenticated) {
    return (
      <main className="first-time-view">
        {/* Header */}
        <header className="popup-header">
          <div className="header-brand">
            <div>
              <h1>CommitFlow</h1>
              <p className="brand-sub">Competitive programming → GitHub</p>
            </div>
          </div>
          <span className="pill pill-version">v1.0</span>
        </header>

        {/* Hero Headline */}
        <div className="flow-hero">
          <h2 className="flow-headline">Connect your GitHub</h2>
          <p className="flow-subheadline">
            Automatically sync accepted solutions from 5 platforms to your personal GitHub repository.
          </p>
        </div>

        {notice && (
          <div className="alert-notice">
            <span>{notice}</span>
            <button className="notice-dismiss" onClick={() => setNotice('')}>×</button>
          </div>
        )}

        {/* Visual Flow Diagram: 5 platforms flowing into CommitFlow, then GitHub */}
        <div className="flow-diagram-card">
          <div className="flow-stage">
            <div className="stage-label">Supported platforms</div>
            <div className="flow-platforms-cluster">
              <span className="flow-chip chip-leetcode">LeetCode</span>
              <span className="flow-chip chip-codeforces">Codeforces</span>
              <span className="flow-chip chip-codechef">CodeChef</span>
              <span className="flow-chip chip-cses">CSES</span>
              <span className="flow-chip chip-atcoder">AtCoder</span>
            </div>
          </div>

          <div className="flow-arrow-wrap">
            <svg width="28" height="24" viewBox="0 0 28 24" fill="none">
              <path d="M7 2 C7 12, 14 10, 14 16" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="3 3" />
              <path d="M21 2 C21 12, 14 10, 14 16" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="3 3" />
              <line x1="14" y1="2" x2="14" y2="16" stroke="#059669" strokeWidth="2" />
              <polygon points="10,15 14,22 18,15" fill="#059669" />
            </svg>
          </div>

          <div className="flow-stage">
            <div className="flow-node flow-node-hub">
              <div className="node-icon-wrap">
                <CommitFlowIcon />
              </div>
              <div className="node-info">
                <span className="node-title">CommitFlow</span>
                <span className="node-badge">Auto Sync</span>
              </div>
            </div>
          </div>

          <div className="flow-arrow-wrap">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <line x1="12" y1="2" x2="12" y2="16" stroke="#64748b" strokeWidth="2" strokeDasharray="3 3" />
              <polygon points="8,15 12,22 16,15" fill="#0f172a" />
            </svg>
          </div>

          <div className="flow-stage">
            <div className="flow-node flow-node-github">
              <div className="node-icon-wrap">
                <GitHubIcon />
              </div>
              <div className="node-info">
                <span className="node-title">GitHub</span>
                <span className="node-sub">Personal repository</span>
              </div>
            </div>
          </div>
        </div>

        {/* Primary CTA */}
        <div className="flow-cta-wrap">
          <button className="btn-connect-gh" onClick={() => void signIn()}>
            <GitHubIcon />
            <span>Connect GitHub</span>
          </button>
        </div>

        {/* Footer */}
        <footer className="popup-footer">
          <button
            className="btn-link"
            onClick={() => chrome.runtime.openOptionsPage()}
          >
            ⚙️ Advanced settings
          </button>
        </footer>
      </main>
    );
  }

  return (
    <main>
      {/* 1. Header */}
      <header className="popup-header">
        <div className="header-brand">
          <div>
            <h1>CommitFlow</h1>
            <p className="brand-sub">Competitive programming → GitHub</p>
          </div>
        </div>
        <span className="pill pill-version">v1.0</span>
      </header>

      {/* 2. Sync alert / status */}
      <div className={`status-banner status-${settings.enabled ? 'active' : 'paused'}`}>
        <div className="status-dot-pulse"></div>
        <div className="status-text-wrap">
          <span className="status-state-lbl">{settings.enabled ? 'Syncing active' : 'Sync paused'}</span>
          <span className="status-message-text" role="status">{status.message}</span>
        </div>
      </div>

      {status.latestGitHubError && (
        <div className="alert-error">
          <span>⚠️</span>
          <span>Latest GitHub error: {status.latestGitHubError}</span>
        </div>
      )}

      {notice && (
        <div className="alert-notice">
          <span>{notice}</span>
          <button className="notice-dismiss" onClick={() => setNotice('')}>×</button>
        </div>
      )}

      {/* 3. GitHub repository */}
      <div className="card-section">
        <div className="card-header-row">
          <span className="card-title">GitHub repository</span>
          {authenticated && (
            <button
              className="btn-text"
              onClick={() => {
                const nextState = !showRepoPicker;
                setShowRepoPicker(nextState);
                if (nextState && repoLoadState === 'idle') void loadRepos();
              }}
            >
              {showRepoPicker ? 'Cancel' : (settings.repository ? 'Change' : 'Configure')}
            </button>
          )}
        </div>

        {!authenticated ? (
          <div className="connect-row">
            <p className="hint-text">Connect your GitHub account to sync solutions.</p>
            <button className="btn-primary btn-sm" onClick={() => void signIn()}>
              Connect GitHub
            </button>
          </div>
        ) : (
          <div className="repo-display-row">
            <div className="repo-badge">
              <span className="repo-icon">📦</span>
              <span className="repo-name">{settings.repository || 'No repository selected'}</span>
            </div>
          </div>
        )}

        {authenticated && showRepoPicker && (
          <div className="repo-picker-box">
            <div className="repo-input-group">
              <input
                type="text"
                placeholder="owner/Competitive-Programming"
                value={customRepo}
                onChange={e => setCustomRepo(e.target.value)}
              />
              <button
                className="btn-secondary btn-sm"
                onClick={() => void useRepository(customRepo)}
              >
                Use
              </button>
            </div>

            <div className="repo-actions-row">
              <button
                className="btn-outline btn-xs"
                onClick={() => void loadRepos()}
                disabled={repoLoadState === 'loading'}
              >
                {repoLoadState === 'loading' ? 'Loading…' : 'Select existing'}
              </button>
              <button
                className="btn-outline btn-xs"
                onClick={() => void createRepo()}
              >
                Create repo
              </button>
            </div>

            {repoLoadState === 'loaded' && repos.length > 0 && (
              <select
                className="repo-select"
                value=""
                onChange={e => { if (e.target.value) void useRepository(e.target.value); }}
              >
                <option value="">Choose from your repositories…</option>
                {repos.map(r => (
                  <option key={r.full_name} value={r.full_name}>
                    {r.full_name}{r.private ? ' (private)' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      {/* 4. 5 Platform cards */}
      <div className="card-section">
        <span className="card-title">Supported platforms</span>
        <div className="platforms-grid">
          {platforms.map(p => (
            <div key={p.id} className="platform-card">
              <span className="platform-name">{p.name}</span>
              <span className="platform-indicator">
                <span className="indicator-dot"></span>Active
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 5. Automatic sync */}
      <div className="card-section">
        <div className="between">
          <div>
            <span className="toggle-label">Automatic sync</span>
            <p className="toggle-sub">Commit verified Accepted solutions</p>
          </div>
          <button
            className={`btn-toggle ${settings.enabled ? 'toggle-on' : 'toggle-off'}`}
            onClick={() => void toggle()}
          >
            {settings.enabled ? 'Enabled' : 'Paused'}
          </button>
        </div>
      </div>

      {/* 6. Activity / retry */}
      <div className="card-section">
        <div className="card-header-row">
          <span className="card-title">Activity</span>
          <span className="stats-summary">
            <strong>{counts.committed}</strong> committed
            {counts.pending > 0 && <> · <strong>{counts.pending}</strong> pending</>}
            {counts.retrying > 0 && <> · <strong>{counts.retrying}</strong> retrying</>}
            {counts.permanentlyFailed > 0 && <> · <strong className="text-danger">{counts.permanentlyFailed}</strong> failed</>}
          </span>
        </div>

        {(status.pending > 0 || counts.permanentlyFailed > 0) && (
          <div className="retry-actions-row">
            {status.pending > 0 && (
              <button className="btn-secondary btn-sm" onClick={() => void retry()}>
                Retry queue ({status.pending})
              </button>
            )}
            {counts.permanentlyFailed > 0 && (
              <button className="btn-danger btn-sm" onClick={() => void retryFailed()}>
                Retry failed submissions ({counts.permanentlyFailed})
              </button>
            )}
          </div>
        )}
      </div>

      {/* 7. Advanced settings */}
      <footer className="popup-footer">
        <button
          className="btn-link"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          ⚙️ Advanced settings
        </button>
      </footer>
    </main>
  );
}
