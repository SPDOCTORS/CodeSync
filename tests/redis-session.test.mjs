import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MemoryRedisClient, RedisSessionStore, createSessionStore, ONE_YEAR_SECONDS } from '../server/session-store.mjs';
import { createRequestHandler } from '../server/index.mjs';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('MemoryRedisClient correctly handles get, set with EX/PX, del, expire, and ttl', async () => {
  const client = new MemoryRedisClient();

  // Basic set and get
  assert.equal(await client.set('foo', 'bar'), 'OK');
  assert.equal(await client.get('foo'), 'bar');

  // Del
  assert.equal(await client.del('foo'), 1);
  assert.equal(await client.get('foo'), null);
  assert.equal(await client.del('foo'), 0);

  // Set with EX (seconds)
  await client.set('temp', 'val', 'EX', 10);
  assert.equal(await client.get('temp'), 'val');
  const ttl = await client.ttl('temp');
  assert.ok(ttl > 0 && ttl <= 10, `TTL should be around 10, got ${ttl}`);

  // Expire
  await client.expire('temp', 30);
  const updatedTtl = await client.ttl('temp');
  assert.ok(updatedTtl > 10 && updatedTtl <= 30, `Updated TTL should be around 30, got ${updatedTtl}`);

  // Expired key returns null
  await client.set('short', 'quick', 'PX', 1);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(await client.get('short'), null);
  assert.equal(await client.ttl('short'), -2);
});

test('RedisSessionStore generates opaque session tokens and keeps GitHub tokens server-side', async () => {
  const client = new MemoryRedisClient();
  const store = new RedisSessionStore(client);

  const githubToken = 'gho_secretGitHubToken1234567890';
  const sessionToken = await store.createSession(githubToken);

  // Token is an opaque base64url random string of high entropy
  assert.equal(typeof sessionToken, 'string');
  assert.ok(sessionToken.length >= 40, `Session token should be at least 40 chars, got ${sessionToken.length}`);
  assert.ok(!sessionToken.includes(githubToken), 'Session token must not contain the GitHub token');
  assert.ok(!sessionToken.includes('gho_'), 'Session token must not leak token prefixes');

  // The session token is the key in Redis, and GitHub token is stored inside the value
  const redisKey = `codesync:session:${sessionToken}`;
  const rawInRedis = await client.get(redisKey);
  assert.ok(rawInRedis != null, 'Session must exist in Redis under the sessionKey');
  const parsed = JSON.parse(rawInRedis);
  assert.equal(parsed.githubToken, githubToken, 'GitHub token must be stored server-side in Redis');

  // Retrieval via getSession returns the session
  const retrieved = await store.getSession(sessionToken);
  assert.ok(retrieved != null);
  assert.equal(retrieved.githubToken, githubToken);
  assert.ok(retrieved.expires > Date.now());
});

test('sessions persist across backend restarts when connected to the same Redis store', async () => {
  const sharedMemory = new Map();

  // First server instance creates session
  const clientInstance1 = new MemoryRedisClient(sharedMemory);
  const storeInstance1 = new RedisSessionStore(clientInstance1);
  const githubToken = 'ghp_restartPersistenceTestToken';
  const sessionToken = await storeInstance1.createSession(githubToken);
  await storeInstance1.close();

  // Second server instance starts up afresh after restart
  const clientInstance2 = new MemoryRedisClient(sharedMemory);
  const storeInstance2 = new RedisSessionStore(clientInstance2);
  const restoredSession = await storeInstance2.getSession(sessionToken);

  assert.ok(restoredSession != null, 'Session must persist across server restarts');
  assert.equal(restoredSession.githubToken, githubToken, 'Stored GitHub token must be preserved across restarts');
  await storeInstance2.close();
});

test('session store defaults to 1-year sliding TTL and getSession slides key expiry', async () => {
  const client = new MemoryRedisClient();
  const store = new RedisSessionStore(client);

  assert.equal(store.sessionTtlSeconds, ONE_YEAR_SECONDS);
  assert.equal(ONE_YEAR_SECONDS, 31_536_000);

  // Create session with custom short initial TTL to prove sliding extension
  const sessionToken = await store.createSession('gho_slidingToken', 100);
  const initialTtl = await client.ttl(store.sessionKey(sessionToken));
  assert.ok(initialTtl <= 100 && initialTtl > 0, `Initial TTL should be <= 100, got ${initialTtl}`);

  // Calling getSession should slide/refresh the TTL in Redis back to 1 year (31,536,000s)
  const session = await store.getSession(sessionToken);
  assert.ok(session != null);
  const refreshedTtl = await client.ttl(store.sessionKey(sessionToken));
  assert.ok(refreshedTtl > 31_000_000 && refreshedTtl <= ONE_YEAR_SECONDS, `Refreshed TTL should be ~1 year, got ${refreshedTtl}`);
});

test('session TTL and automatic expiry work as expected for expired sessions', async () => {
  const client = new MemoryRedisClient();
  const store = new RedisSessionStore(client, { sessionTtlSeconds: 1 });

  // Create session with short TTL of 1 second
  const sessionToken = await store.createSession('gho_expiryToken', 1);
  const beforeExpiry = await store.getSession(sessionToken, { touch: false });
  assert.ok(beforeExpiry != null, 'Session should be valid immediately after creation');

  // Verify TTL in Redis
  const ttl = await client.ttl(store.sessionKey(sessionToken));
  assert.ok(ttl >= 1, `TTL in Redis should be >= 1, got ${ttl}`);

  // Wait for expiry
  await new Promise(r => setTimeout(r, 1100));

  // Should return null and be cleaned up
  const afterExpiry = await store.getSession(sessionToken, { touch: false });
  assert.equal(afterExpiry, null, 'Expired session must return null');
  assert.equal(await client.get(store.sessionKey(sessionToken)), null, 'Expired key must be removed from Redis');
});

test('deleteSession removes the session from Redis', async () => {
  const client = new MemoryRedisClient();
  const store = new RedisSessionStore(client);

  const sessionToken = await store.createSession('gho_tokenToDelete');
  assert.ok((await store.getSession(sessionToken)) != null);

  const deleted = await store.deleteSession(sessionToken);
  assert.equal(deleted, true);
  assert.equal(await store.getSession(sessionToken), null);

  // Deleting again returns false
  assert.equal(await store.deleteSession(sessionToken), false);
});

test('touchSession refreshes the Redis TTL', async () => {
  const client = new MemoryRedisClient();
  const store = new RedisSessionStore(client);

  const sessionToken = await store.createSession('gho_tokenToTouch', 60);
  assert.equal(await store.touchSession(sessionToken, 300), true);

  const ttl = await client.ttl(store.sessionKey(sessionToken));
  assert.ok(ttl > 60 && ttl <= 300, `TTL should have extended to ~300, got ${ttl}`);

  // Touching a non-existent session returns false
  assert.equal(await store.touchSession('non_existent_token'), false);
});

test('OAuth state transaction store supports creation, lookup, expiry, and deletion', async () => {
  const client = new MemoryRedisClient();
  const store = new RedisSessionStore(client, { txTtlSeconds: 600 });

  const state = 'state_12345';
  const txData = {
    redirectUri: 'https://extensionid.chromiumapp.org/github',
    clientState: 'client_state_abc',
  };

  await store.setTransaction(state, txData, 600);
  const retrieved = await store.getTransaction(state);
  assert.ok(retrieved != null);
  assert.equal(retrieved.redirectUri, txData.redirectUri);
  assert.equal(retrieved.clientState, txData.clientState);
  assert.ok(retrieved.expires > Date.now());

  // Deletion
  assert.equal(await store.deleteTransaction(state), true);
  assert.equal(await store.getTransaction(state), null);
});

test('OAuth handoff store supports one-time exchange and short TTL', async () => {
  const client = new MemoryRedisClient();
  const store = new RedisSessionStore(client, { handoffTtlSeconds: 120 });

  const code = 'handoff_code_xyz';
  const handoffData = {
    redirectUri: 'https://extensionid.chromiumapp.org/github',
    clientState: 'client_state_abc',
    githubToken: 'gho_exchangedToken123',
  };

  await store.setHandoff(code, handoffData, 120);
  const retrieved = await store.getHandoff(code);
  assert.ok(retrieved != null);
  assert.equal(retrieved.githubToken, handoffData.githubToken);

  // Consuming the handoff
  assert.equal(await store.deleteHandoff(code), true);
  assert.equal(await store.getHandoff(code), null);
});

test('createSessionStore supports default memory fallback when REDIS_URL is not provided', () => {
  const store = createSessionStore({ fallbackToMemory: true });
  assert.ok(store instanceof RedisSessionStore);
  assert.equal(store.isInMemory, true);
});

test('HTTP handler: health check succeeds without authentication', async () => {
  const store = new RedisSessionStore(new MemoryRedisClient());
  const handler = createRequestHandler({ baseUrl: 'http://localhost:8787', store });

  const req = {
    method: 'GET',
    url: '/healthz',
    headers: {},
  };

  let statusCode = null;
  let headers = {};
  let body = '';

  const res = {
    writeHead(status, h) {
      statusCode = status;
      headers = h;
    },
    end(data) {
      body = data;
    },
  };

  await handler(req, res);
  assert.equal(statusCode, 200);
  assert.deepEqual(JSON.parse(body), { ok: true });
});

test('HTTP handler: /v1/github/session rejects missing, invalid, or expired tokens with 401', async () => {
  const store = new RedisSessionStore(new MemoryRedisClient());
  const mockFetch = async (url) => {
    if (url === 'https://api.github.com/user') {
      return { ok: true, status: 200, json: async () => ({ login: 'octocat' }) };
    }
    return { ok: false, status: 404, text: async () => 'Not found' };
  };
  const handler = createRequestHandler({ baseUrl: 'http://localhost:8787', store, fetchFn: mockFetch });

  const runRequest = async (authHeader) => {
    let statusCode = null;
    let body = '';
    const req = {
      method: 'GET',
      url: '/v1/github/session',
      headers: authHeader ? { authorization: authHeader } : {},
    };
    const res = {
      writeHead(status) { statusCode = status; },
      end(data) { body = data; },
    };
    await handler(req, res);
    return { statusCode, body: JSON.parse(body) };
  };

  // Missing header
  const r1 = await runRequest(undefined);
  assert.equal(r1.statusCode, 401);
  assert.equal(r1.body.error, 'Sign in again.');

  // Malformed token
  const r2 = await runRequest('Basic abc');
  assert.equal(r2.statusCode, 401);
  assert.equal(r2.body.error, 'Sign in again.');

  // Non-existent token
  const r3 = await runRequest('Bearer non_existent_token');
  assert.equal(r3.statusCode, 401);
  assert.equal(r3.body.error, 'Sign in again.');

  // Expired token
  const expiredToken = await store.createSession('gho_expired', -10);
  const r4 = await runRequest(`Bearer ${expiredToken}`);
  assert.equal(r4.statusCode, 401);
  assert.equal(r4.body.error, 'Sign in again.');

  // Valid active session
  const validToken = await store.createSession('gho_valid', 3600);
  const r5 = await runRequest(`Bearer ${validToken}`);
  assert.equal(r5.statusCode, 200);
  assert.deepEqual(r5.body, { ok: true });
});

test('HTTP handler: revoked token on GitHub purges session from Redis and returns 401', async () => {
  const client = new MemoryRedisClient();
  const store = new RedisSessionStore(client);

  const mockRevokedFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"message":"Bad credentials"}',
  });

  const handler = createRequestHandler({
    baseUrl: 'http://localhost:8787',
    store,
    fetchFn: mockRevokedFetch,
  });

  const sessionToken = await store.createSession('gho_revokedOnGitHub');
  assert.ok((await store.getSession(sessionToken)) != null);

  let statusCode = null;
  let body = '';
  const req = {
    method: 'GET',
    url: '/v1/github/session',
    headers: { authorization: `Bearer ${sessionToken}` },
  };
  const res = {
    writeHead(status) { statusCode = status; },
    end(data) { body = data; },
  };

  await handler(req, res);
  assert.equal(statusCode, 401);
  assert.equal(JSON.parse(body).error, 'Sign in again.');

  // The revoked session must have been deleted from Redis
  const purged = await store.getSession(sessionToken);
  assert.equal(purged, null, 'Revoked session must be purged from Redis on 401');
});

test('HTTP handler: OAuth exchange creates session in Redis and returns opaque sessionToken', async () => {
  const store = new RedisSessionStore(new MemoryRedisClient());
  const handler = createRequestHandler({ baseUrl: 'http://localhost:8787', store });

  const handoffCode = 'handoff_secret_code_123';
  const redirectUri = 'https://abcdefghijklmnop.chromiumapp.org/github';
  const githubToken = 'gho_superSecretFromGitHub';

  await store.setHandoff(handoffCode, {
    redirectUri,
    clientState: 'client_state_test',
    githubToken,
  }, 120);

  // Send POST /v1/oauth/github/exchange
  const bodyPayload = JSON.stringify({ code: handoffCode, redirect_uri: redirectUri });
  let statusCode = null;
  let responseBody = '';

  const req = {
    method: 'POST',
    url: '/v1/oauth/github/exchange',
    headers: { 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') cb(bodyPayload);
      if (event === 'end') cb();
    },
  };
  const res = {
    writeHead(status) { statusCode = status; },
    end(data) { responseBody = data; },
  };

  await handler(req, res);
  assert.equal(statusCode, 200);
  const result = JSON.parse(responseBody);
  assert.ok(typeof result.sessionToken === 'string');
  assert.ok(!result.sessionToken.includes(githubToken));

  // The session is now active in Redis with the githubToken
  const sessionInStore = await store.getSession(result.sessionToken);
  assert.ok(sessionInStore != null);
  assert.equal(sessionInStore.githubToken, githubToken);

  // Handoff code cannot be replayed
  const replayReq = {
    method: 'POST',
    url: '/v1/oauth/github/exchange',
    headers: { 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') cb(bodyPayload);
      if (event === 'end') cb();
    },
  };
  let replayStatus = null;
  let replayBody = '';
  const replayRes = {
    writeHead(status) { replayStatus = status; },
    end(data) { replayBody = data; },
  };
  await handler(replayReq, replayRes);
  assert.equal(replayStatus, 400);
  assert.equal(JSON.parse(replayBody).error, 'Invalid or expired authorization handoff.');
});

test('client contracts: backendSession is persisted across browser restarts and cleaned up on 401', async () => {
  const [background, github] = await Promise.all([
    read('src/background/index.ts'),
    read('src/lib/github.ts'),
  ]);

  // Sign-in persists to chrome.storage.local (survives browser restart)
  assert.match(background, /chrome\.storage\.local\.set\(\{\s*backendSession:\s*payload\.sessionToken\s*\}\)/);
  assert.match(background, /chrome\.storage\.session\.set\(\{\s*backendSession:\s*payload\.sessionToken\s*\}\)/);

  // 401 error clears both session and local storage
  assert.match(background, /chrome\.storage\.session\.remove\('backendSession'\)/);
  assert.match(background, /chrome\.storage\.local\.remove\('backendSession'\)/);

  // githubService checks local storage (survives browser restart)
  assert.match(github, /chrome\.storage\.local\.get\('backendSession'\)/);
  assert.match(github, /local\.backendSession \?\? session\.backendSession/);
});

test('client logic: session recovery from chrome.storage.local when session storage is wiped on browser restart', async () => {
  const mockLocalStorage = new Map();
  const mockSessionStorage = new Map();

  const chromeMock = {
    storage: {
      local: {
        get: async (key) => ({ [key]: mockLocalStorage.get(key) }),
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) mockLocalStorage.set(k, v); },
        remove: async (key) => { mockLocalStorage.delete(key); },
      },
      session: {
        get: async (key) => ({ [key]: mockSessionStorage.get(key) }),
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) mockSessionStorage.set(k, v); },
        remove: async (key) => { mockSessionStorage.delete(key); },
      },
    },
  };

  const getBackendSession = async () => {
    const local = await chromeMock.storage.local.get('backendSession');
    const session = await chromeMock.storage.session.get('backendSession');
    return local.backendSession ?? session.backendSession ?? null;
  };

  const opaqueToken = 'opaque_session_token_persisted_across_browser_restart';
  // User signs in
  mockLocalStorage.set('backendSession', opaqueToken);
  mockSessionStorage.set('backendSession', opaqueToken);

  // Browser restarts: session storage is completely wiped
  mockSessionStorage.clear();
  assert.equal(mockSessionStorage.size, 0);

  // Session is still recovered from local storage!
  assert.equal(await getBackendSession(), opaqueToken);

  // Revocation / 401 clears both
  await chromeMock.storage.session.remove('backendSession');
  await chromeMock.storage.local.remove('backendSession');
  assert.equal(await getBackendSession(), null);
});

test('RedisSessionStore ensures lazy client connects before issuing commands', async () => {
  let connectCount = 0;
  const storeMap = new Map();

  const mockLazyClient = {
    status: 'wait',
    async connect() {
      connectCount++;
      await new Promise(r => setTimeout(r, 5));
      this.status = 'ready';
    },
    async set(key, val, ...args) {
      if (this.status !== 'ready') {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }
      storeMap.set(key, val);
      return 'OK';
    },
    async get(key) {
      if (this.status !== 'ready') {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }
      return storeMap.get(key) ?? null;
    },
    async del(key) {
      if (this.status !== 'ready') {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }
      return storeMap.delete(key) ? 1 : 0;
    },
    async expire(key, sec) {
      if (this.status !== 'ready') {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }
      return 1;
    },
  };

  const store = new RedisSessionStore(mockLazyClient);
  assert.equal(mockLazyClient.status, 'wait');

  // createSession must await connect() and succeed without throwing offline queue error
  const sessionToken = await store.createSession('gho_test_token_123');
  assert.equal(connectCount, 1);
  assert.equal(mockLazyClient.status, 'ready');

  // getSession on ready client must NOT call connect() again
  const session = await store.getSession(sessionToken);
  assert.equal(connectCount, 1);
  assert.equal(session.githubToken, 'gho_test_token_123');
});

test('RedisSessionStore coalesces concurrent operations to a single connect() call', async () => {
  let connectCount = 0;
  const storeMap = new Map();

  const mockLazyClient = {
    status: 'wait',
    async connect() {
      connectCount++;
      await new Promise(r => setTimeout(r, 20));
      this.status = 'ready';
    },
    async set(key, val, ...args) {
      if (this.status !== 'ready') {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }
      storeMap.set(key, val);
      return 'OK';
    },
    async get(key) {
      if (this.status !== 'ready') {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }
      return storeMap.get(key) ?? null;
    },
    async del(key) {
      return storeMap.delete(key) ? 1 : 0;
    },
  };

  const store = new RedisSessionStore(mockLazyClient);

  // Issue 5 concurrent calls while client is in 'wait' state
  const results = await Promise.all([
    store.createSession('tok_1'),
    store.createSession('tok_2'),
    store.createSession('tok_3'),
    store.createSession('tok_4'),
    store.createSession('tok_5'),
  ]);

  assert.equal(results.length, 5);
  // connect() was only called once for all 5 concurrent operations!
  assert.equal(connectCount, 1);
  assert.equal(mockLazyClient.status, 'ready');
});

test('RedisSessionStore fails closed when connect fails, without falling back to memory', async () => {
  let shouldFail = true;
  let connectAttempts = 0;

  const mockFailingClient = {
    status: 'wait',
    async connect() {
      connectAttempts++;
      if (shouldFail) {
        this.status = 'wait';
        throw new Error('Connection refused by Redis server');
      }
      this.status = 'ready';
    },
    async get(key) {
      if (this.status !== 'ready') {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }
      return null;
    },
  };

  const store = new RedisSessionStore(mockFailingClient);

  // Fails closed by throwing the connection error
  await assert.rejects(
    () => store.getSession('test_token'),
    err => {
      assert.ok(err.message.includes('Connection refused'));
      return true;
    }
  );
  assert.equal(connectAttempts, 1);

  // The connecting promise is cleared so subsequent retry can succeed
  shouldFail = false;
  const result = await store.getSession('test_token');
  assert.equal(result, null);
  assert.equal(connectAttempts, 2);
  assert.equal(mockFailingClient.status, 'ready');
});

