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

  async createSession(githubToken, ttlSeconds = this.sessionTtlSeconds) {
    const sessionToken = this.generateToken();
    await this.setSession(sessionToken, { githubToken }, ttlSeconds);
    return sessionToken;
  }

  async setSession(sessionToken, data, ttlSeconds = this.sessionTtlSeconds) {
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
    const key = this.sessionKey(sessionToken);
    const count = await this.client.del(key);
    return count > 0;
  }

  async touchSession(sessionToken, ttlSeconds = this.sessionTtlSeconds) {
    if (!sessionToken) return false;
    const key = this.sessionKey(sessionToken);
    const res = await this.client.expire(key, ttlSeconds);
    return res > 0;
  }

  async setTransaction(state, data, ttlSeconds = this.txTtlSeconds) {
    const key = this.txKey(state);
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const payload = JSON.stringify({ ...data, expires: expiresAt });
    await this.client.set(key, payload, 'EX', ttlSeconds);
    return { state, expires: expiresAt };
  }

  async getTransaction(state) {
    if (!state) return null;
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
    const key = this.txKey(state);
    const count = await this.client.del(key);
    return count > 0;
  }

  async setHandoff(code, data, ttlSeconds = this.handoffTtlSeconds) {
    const key = this.handoffKey(code);
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const payload = JSON.stringify({ ...data, expires: expiresAt });
    await this.client.set(key, payload, 'EX', ttlSeconds);
    return { code, expires: expiresAt };
  }

  async getHandoff(code) {
    if (!code) return null;
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

  const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
  if (redisUrl) {
    const client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: times => Math.min(times * 100, 3000),
      ...options.redisOptions,
    });
    client.on('error', err => {
      console.error('[Redis error]', err?.message ?? err);
    });
    return new RedisSessionStore(client, { ...options, isInMemory: false });
  }

  if (options.fallbackToMemory !== false) {
    return new RedisSessionStore(new MemoryRedisClient(), { ...options, isInMemory: true });
  }

  const client = new Redis('redis://127.0.0.1:6379', options.redisOptions);
  return new RedisSessionStore(client, { ...options, isInMemory: false });
}
