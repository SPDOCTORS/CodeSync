import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';

export const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60; // 31,536,000 seconds

/**
 * In-memory fallback Redis client implementing Redis key-value and TTL commands.
 * Used for tests and zero-configuration local development when REDIS_URL is not provided.
 */
export class MemoryRedisClient {
  constructor(sharedStore = new Map()) {
    this.store = sharedStore;
  }

  async get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt && item.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  async set(key, value, ...args) {
    let expiresAt = null;
    for (let i = 0; i < args.length; i++) {
      const flag = String(args[i]).toUpperCase();
      if (flag === 'EX' && args[i + 1] != null) {
        expiresAt = Date.now() + Number(args[i + 1]) * 1000;
        i++;
      } else if (flag === 'PX' && args[i + 1] != null) {
        expiresAt = Date.now() + Number(args[i + 1]);
        i++;
      }
    }
    this.store.set(key, { value: String(value), expiresAt });
    return 'OK';
  }

  async del(...keys) {
    let count = 0;
    for (const key of keys.flat()) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  async expire(key, seconds) {
    const item = this.store.get(key);
    if (!item) return 0;
    if (item.expiresAt && item.expiresAt <= Date.now()) {
      this.store.delete(key);
      return 0;
    }
    item.expiresAt = Date.now() + Number(seconds) * 1000;
    return 1;
  }

  async ttl(key) {
    const item = this.store.get(key);
    if (!item) return -2;
    if (item.expiresAt && item.expiresAt <= Date.now()) {
      this.store.delete(key);
      return -2;
    }
    if (!item.expiresAt) return -1;
    return Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1000));
  }

  async quit() {
    return 'OK';
  }
}

/**
 * Persistent Redis-backed session store for CodeSync OAuth and API authentication.
 *
 * Keeps opaque session IDs in the extension and GitHub tokens server-side in Redis.
 * Uses a 1-year sliding TTL so active sessions persist indefinitely across browser
 * and backend restarts while preserving revocation and expiry handling.
 */
export class RedisSessionStore {
  constructor(client, options = {}) {
    this.client = client;
    this.prefix = options.prefix ?? 'codesync:';
    this.sessionTtlSeconds = options.sessionTtlSeconds ?? Number(process.env.SESSION_TTL_SECONDS ?? ONE_YEAR_SECONDS);
    this.txTtlSeconds = options.txTtlSeconds ?? 600; // 10 minutes
    this.handoffTtlSeconds = options.handoffTtlSeconds ?? 120; // 2 minutes
    this.isInMemory = Boolean(options.isInMemory);
    this.connectingPromise = null;
  }

  sessionKey(token) {
    return `${this.prefix}session:${token}`;
  }

  txKey(state) {
    return `${this.prefix}oauth:tx:${state}`;
  }

  handoffKey(code) {
    return `${this.prefix}oauth:handoff:${code}`;
  }

  generateToken() {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Ensures the Redis client is connected and ready before issuing commands.
   * Resolves immediately if in-memory or client.status is already 'ready'.
   * If 'connecting', 'connect', or 'reconnecting', awaits the 'ready' event.
   * If 'wait' or 'close', calls connect().
   * Concurrent callers share the same connecting promise.
   */
  async ensureConnected() {
    if (this.isInMemory || !this.client || typeof this.client.connect !== 'function') {
      return;
    }
    if (this.client.status === 'ready') {
      return;
    }
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = (async () => {
      try {
        if (this.client.status === 'ready') {
          return;
        }
        if (this.client.status === 'connecting' || this.client.status === 'connect' || this.client.status === 'reconnecting') {
          await new Promise((resolve, reject) => {
            const onReady = () => { cleanup(); resolve(); };
            const onError = (err) => { cleanup(); reject(err); };
            const onClose = () => { cleanup(); reject(new Error('Redis connection closed before ready')); };
            const cleanup = () => {
              if (typeof this.client.removeListener === 'function') {
                this.client.removeListener('ready', onReady);
                this.client.removeListener('error', onError);
                this.client.removeListener('close', onClose);
                this.client.removeListener('end', onClose);
              }
            };
            if (typeof this.client.once === 'function') {
              this.client.once('ready', onReady);
              this.client.once('error', onError);
              this.client.once('close', onClose);
              this.client.once('end', onClose);
            } else {
              resolve();
            }
          });
          return;
        }
        await this.client.connect();
      } finally {
        this.connectingPromise = null;
      }
    })();

    return this.connectingPromise;
  }

  async createSession(githubToken, ttlSeconds = this.sessionTtlSeconds) {
    const sessionToken = this.generateToken();
    await this.setSession(sessionToken, { githubToken }, ttlSeconds);
    return sessionToken;
  }

  async setSession(sessionToken, data, ttlSeconds = this.sessionTtlSeconds) {
    await this.ensureConnected();
    const key = this.sessionKey(sessionToken);
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const payload = JSON.stringify({
      ...data,
      expires: expiresAt,
    });
    await this.client.set(key, payload, 'EX', ttlSeconds);
    return { sessionToken, expires: expiresAt };
  }

  /**
   * Retrieves a session from Redis.
   * If touch is true (default), implements a sliding TTL by refreshing
   * the Redis key expiry to sessionTtlSeconds (1 year).
   */
  async getSession(sessionToken, { touch = true } = {}) {
    if (!sessionToken) return null;
    await this.ensureConnected();
    const key = this.sessionKey(sessionToken);
    const raw = await this.client.get(key);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (data.expires && data.expires <= Date.now()) {
        await this.client.del(key);
        return null;
      }
      if (touch) {
        data.expires = Date.now() + this.sessionTtlSeconds * 1000;
        await this.client.expire(key, this.sessionTtlSeconds);
      }
      return data;
    } catch {
      await this.client.del(key);
      return null;
    }
  }

  async deleteSession(sessionToken) {
    if (!sessionToken) return false;
    await this.ensureConnected();
    const key = this.sessionKey(sessionToken);
    const count = await this.client.del(key);
    return count > 0;
  }

  async touchSession(sessionToken, ttlSeconds = this.sessionTtlSeconds) {
    if (!sessionToken) return false;
    await this.ensureConnected();
    const key = this.sessionKey(sessionToken);
    const res = await this.client.expire(key, ttlSeconds);
    return res > 0;
  }

  async setTransaction(state, data, ttlSeconds = this.txTtlSeconds) {
    await this.ensureConnected();
    const key = this.txKey(state);
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const payload = JSON.stringify({ ...data, expires: expiresAt });
    await this.client.set(key, payload, 'EX', ttlSeconds);
    return { state, expires: expiresAt };
  }

  async getTransaction(state) {
    if (!state) return null;
    await this.ensureConnected();
    const key = this.txKey(state);
    const raw = await this.client.get(key);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (data.expires && data.expires <= Date.now()) {
        await this.client.del(key);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  async deleteTransaction(state) {
    if (!state) return false;
    await this.ensureConnected();
    const key = this.txKey(state);
    const count = await this.client.del(key);
    return count > 0;
  }

  async setHandoff(code, data, ttlSeconds = this.handoffTtlSeconds) {
    await this.ensureConnected();
    const key = this.handoffKey(code);
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const payload = JSON.stringify({ ...data, expires: expiresAt });
    await this.client.set(key, payload, 'EX', ttlSeconds);
    return { code, expires: expiresAt };
  }

  async getHandoff(code) {
    if (!code) return null;
    await this.ensureConnected();
    const key = this.handoffKey(code);
    const raw = await this.client.get(key);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (data.expires && data.expires <= Date.now()) {
        await this.client.del(key);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  async deleteHandoff(code) {
    if (!code) return false;
    await this.ensureConnected();
    const key = this.handoffKey(code);
    const count = await this.client.del(key);
    return count > 0;
  }

  async close() {
    if (this.client && typeof this.client.quit === 'function') {
      await this.client.quit();
    }
  }
}

/**
 * Creates a session store instance.
 *
 * If options.client is provided, uses it directly.
 * If REDIS_URL is provided, creates an ioredis client connected to that URL.
 * Otherwise, falls back to MemoryRedisClient if fallbackToMemory is not false.
 */
export function createSessionStore(options = {}) {
  if (options.client) {
    return new RedisSessionStore(options.client, options);
  }

  const rawRedisUrl = options.redisUrl ?? process.env.REDIS_URL;
  if (rawRedisUrl) {
    let redisUrl = typeof rawRedisUrl === 'string' ? rawRedisUrl.trim().replace(/^["']|["']$/g, '') : rawRedisUrl;
    // Upstash requires TLS (rediss://). Upgrade unencrypted redis:// for Upstash hosts.
    if (typeof redisUrl === 'string' && redisUrl.includes('upstash.io') && redisUrl.startsWith('redis://')) {
      redisUrl = 'rediss://' + redisUrl.slice('redis://'.length);
    }
    try {
      const client = new Redis(redisUrl, {
        lazyConnect: true,
        connectTimeout: 5000,
        maxRetriesPerRequest: 3,
        retryStrategy: times => (times > 3 ? null : Math.min(times * 100, 3000)),
        enableOfflineQueue: false,
        ...options.redisOptions,
      });
      client.on('error', err => {
        const safeMsg = (err?.message ?? String(err)).replace(/:\/\/([^:]+):([^@]+)@/g, '://***:***@');
        console.error('[Redis error]', safeMsg);
      });
      return new RedisSessionStore(client, { ...options, isInMemory: false });
    } catch (err) {
      const safeErrMessage = err?.message || 'Invalid Redis URL format';
      console.error('[REDIS_URL configuration error]', safeErrMessage);
      throw new Error(`[REDIS_URL configuration error] Failed to initialize Redis client: ${safeErrMessage}`);
    }
  }

  if (options.fallbackToMemory !== false) {
    return new RedisSessionStore(new MemoryRedisClient(), { ...options, isInMemory: true });
  }

  try {
    const client = new Redis('redis://127.0.0.1:6379', options.redisOptions);
    return new RedisSessionStore(client, { ...options, isInMemory: false });
  } catch {
    return new RedisSessionStore(new MemoryRedisClient(), { ...options, isInMemory: true });
  }
}
