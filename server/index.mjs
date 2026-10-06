// Deploy this service over HTTPS. http://localhost:8787 is the sole local-development exception.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createSessionStore, ONE_YEAR_SECONDS } from './session-store.mjs';

const required = ['PUBLIC_BASE_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'];
const isDirectRun = Boolean(process.argv[1] && /server[/\\]index\.mjs$/.test(process.argv[1]));
if (isDirectRun) {
  for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
}
const configuredUrl = new URL(process.env.PUBLIC_BASE_URL || 'http://localhost:8787');
const isLocalDevelopment = configuredUrl.protocol === 'http:' && configuredUrl.hostname === 'localhost' && configuredUrl.port === '8787';
if (configuredUrl.protocol !== 'https:' && !isLocalDevelopment) throw new Error('PUBLIC_BASE_URL must use HTTPS, except http://localhost:8787 for local development.');
const baseUrl = configuredUrl.origin;
export const sessionStore = createSessionStore({
  redisUrl: process.env.REDIS_URL,
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? ONE_YEAR_SECONDS),
});
const token = () => randomBytes(32).toString('base64url');
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const body = req => new Promise((resolve, reject) => { let raw=''; req.on('data', chunk => raw += chunk); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } }); req.on('error', reject); });
const github = async (path, init, accessToken, fetchFn = fetch) => { const response = await fetchFn(`https://api.github.com${path}`, { ...init, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}`, 'x-github-api-version': '2022-11-28', ...(init?.headers ?? {}) } }); if (response.status === 401) { const err = new Error('GitHub token revoked or expired.'); err.status = 401; throw err; } if (!response.ok) throw new Error((await response.text()) || `GitHub API error ${response.status}`); return response.status === 204 ? null : response.json(); };
const auth = async req => { const match = req.headers.authorization?.match(/^Bearer (.+)$/); return match ? await sessionStore.getSession(match[1]) : null; };
const validRepo = value => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);

export function createRequestHandler({ baseUrl: base = baseUrl, store = sessionStore, fetchFn = fetch } = {}) {
  return async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' }); return res.end(); }
    const url = new URL(req.url, base);
    const tokenMatch = req.headers.authorization?.match(/^Bearer (.+)$/);
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/v1/oauth/github/start') {
        const redirectUri = url.searchParams.get('redirect_uri'); const clientState = url.searchParams.get('state');
        if (!redirectUri?.match(/^https:\/\/[a-z0-9]+\.chromiumapp\.org\/github$/i) || !clientState) return json(res, 400, { error: 'Invalid extension redirect.' });
        const state = token(); await store.setTransaction(state, { redirectUri, clientState, expires: Date.now() + 600_000 }, 600);
        const githubUrl = new URL('https://github.com/login/oauth/authorize'); githubUrl.search = new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID, redirect_uri: `${base}/v1/oauth/github/callback`, state, scope: 'repo' });
        res.writeHead(302, { location: githubUrl }); return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/v1/oauth/github/callback') {
        const state = url.searchParams.get('state');
        const transaction = state ? await store.getTransaction(state) : null;
        if (state) await store.deleteTransaction(state);
        if (!transaction || transaction.expires < Date.now() || !url.searchParams.get('code')) return json(res, 400, { error: 'Expired OAuth response.' });
        const exchange = await fetchFn('https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: `${base}/v1/oauth/github/callback` }) }).then(r => r.json());
        if (!exchange.access_token) return json(res, 400, { error: 'GitHub token exchange failed.' });
        const handoff = token(); await store.setHandoff(handoff, { ...transaction, githubToken: exchange.access_token, expires: Date.now() + 120_000 }, 120);
        res.writeHead(302, { location: `${transaction.redirectUri}?code=${encodeURIComponent(handoff)}&state=${encodeURIComponent(transaction.clientState)}` }); return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/v1/oauth/github/exchange') {
        const { code, redirect_uri: redirectUri } = await body(req);
        const handoff = code ? await store.getHandoff(code) : null;
        if (code) await store.deleteHandoff(code);
        if (!handoff || handoff.expires < Date.now() || handoff.redirectUri !== redirectUri) return json(res, 400, { error: 'Invalid or expired authorization handoff.' });
        const sessionToken = token();
        const ttl = Number(process.env.SESSION_TTL_SECONDS ?? ONE_YEAR_SECONDS);
        await store.setSession(sessionToken, { githubToken: handoff.githubToken, expires: Date.now() + ttl * 1000 }, ttl);
        return json(res, 200, { sessionToken });
      }
      const session = tokenMatch ? await store.getSession(tokenMatch[1]) : null;
      if (!session || session.expires < Date.now()) return json(res, 401, { error: 'Sign in again.' });
      if (req.method === 'GET' && url.pathname === '/v1/github/session') {
        // Probe GitHub API to confirm token has not been revoked on GitHub
        try {
          await github('/user', undefined, session.githubToken, fetchFn);
          return json(res, 200, { ok: true });
        } catch (error) {
          if (error && error.status === 401) {
            if (tokenMatch?.[1]) await store.deleteSession(tokenMatch[1]);
            return json(res, 401, { error: 'Sign in again.' });
          }
          throw error;
        }
      }
      if (req.method === 'GET' && url.pathname === '/v1/github/repos') { const repos = await github('/user/repos?per_page=100&sort=updated', undefined, session.githubToken, fetchFn); return json(res, 200, repos.map(r => ({ full_name: r.full_name, private: r.private }))); }
      const repositoryMatch = url.pathname.match(/^\/v1\/github\/repos\/([^/]+)$/);
      if (req.method === 'GET' && repositoryMatch) { const repository = decodeURIComponent(repositoryMatch[1]); if (!validRepo(repository)) return json(res, 400, { error: 'Invalid repository.' }); const repo = await github(`/repos/${repository}`, undefined, session.githubToken, fetchFn); return json(res, 200, { full_name: repo.full_name, private: repo.private }); }
      if (req.method === 'POST' && url.pathname === '/v1/github/repos') { const repo = await github('/user/repos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Competitive-Programming', private: true, auto_init: true, description: 'Competitive programming submissions synchronized by CodeSync' }) }, session.githubToken, fetchFn); return json(res, 201, { full_name: repo.full_name }); }
      const matchPath = url.pathname.match(/^\/v1\/github\/repos\/([^/]+)\/contents$/);
      if (req.method === 'PUT' && matchPath) { const repository = decodeURIComponent(matchPath[1]); if (!validRepo(repository)) return json(res, 400, { error: 'Invalid repository.' }); const { path, content, message } = await body(req); if (typeof path !== 'string' || typeof content !== 'string' || typeof message !== 'string') return json(res, 400, { error: 'Invalid commit request.' }); const encodedPath = path.split('/').map(encodeURIComponent).join('/'); const existing = await fetchFn(`https://api.github.com/repos/${repository}/contents/${encodedPath}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${session.githubToken}`, 'x-github-api-version': '2022-11-28' } }); const existingSha = existing.status === 200 ? (await existing.json()).sha : undefined; await github(`/repos/${repository}/contents/${encodedPath}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, content: Buffer.from(content).toString('base64'), ...(existingSha ? { sha: existingSha } : {}) }) }, session.githubToken, fetchFn); return json(res, 201, { ok: true }); }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (error && error.status === 401) {
        if (tokenMatch?.[1]) await store.deleteSession(tokenMatch[1]);
        return json(res, 401, { error: 'Sign in again.' });
      }
      return json(res, 502, { error: error instanceof Error ? error.message : 'Backend error' });
    }
  };
}

export const server = createServer(createRequestHandler());

if (isDirectRun) {
  server.listen(Number(process.env.PORT ?? 8787), () => console.log(`CodeSync backend listening at ${baseUrl}`));
}
