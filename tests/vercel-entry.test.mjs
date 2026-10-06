import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vercelHandler from '../api/index.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('api/index.js exports a callable default serverless handler function', () => {
  assert.equal(typeof vercelHandler, 'function');
});

test('vercelHandler serves /healthz directly', async () => {
  let statusCode = null;
  let responseBody = '';

  const req = {
    method: 'GET',
    url: '/healthz',
    headers: {},
  };
  const res = {
    writeHead(status) { statusCode = status; },
    end(data) { responseBody = data; },
  };

  await vercelHandler(req, res);
  assert.equal(statusCode, 200);
  assert.deepEqual(JSON.parse(responseBody), { ok: true });
});

test('vercelHandler recovers target path from x-matched-path when rewritten by Vercel', async () => {
  let statusCode = null;
  let responseBody = '';

  const req = {
    method: 'GET',
    url: '/api',
    headers: {
      'x-matched-path': '/healthz',
    },
  };
  const res = {
    writeHead(status) { statusCode = status; },
    end(data) { responseBody = data; },
  };

  await vercelHandler(req, res);
  assert.equal(statusCode, 200);
  assert.deepEqual(JSON.parse(responseBody), { ok: true });
  assert.equal(req.url, '/healthz');
});

test('vercelHandler preserves query parameters when recovering path from x-matched-path', async () => {
  let statusCode = null;
  let responseBody = '';

  const req = {
    method: 'GET',
    url: '/api?state=test_state&code=test_code',
    headers: {
      'x-matched-path': '/v1/oauth/github/callback',
    },
  };
  const res = {
    writeHead(status) { statusCode = status; },
    end(data) { responseBody = data; },
  };

  await vercelHandler(req, res);
  // /v1/oauth/github/callback will reject with 400 Expired OAuth response because state is unknown
  assert.equal(statusCode, 400);
  assert.deepEqual(JSON.parse(responseBody), { error: 'Expired OAuth response.' });
  assert.equal(req.url, '/v1/oauth/github/callback?state=test_state&code=test_code');
});

test('vercelHandler preserves 401 rejection for unauthenticated /v1/github/session', async () => {
  let statusCode = null;
  let responseBody = '';

  const req = {
    method: 'GET',
    url: '/api',
    headers: {
      'x-matched-path': '/v1/github/session',
    },
  };
  const res = {
    writeHead(status) { statusCode = status; },
    end(data) { responseBody = data; },
  };

  await vercelHandler(req, res);
  assert.equal(statusCode, 401);
  assert.deepEqual(JSON.parse(responseBody), { error: 'Sign in again.' });
});

test('vercel.json is valid and contains wildcard rewrite to /api', async () => {
  const content = await read('vercel.json');
  const parsed = JSON.parse(content);

  assert.ok(Array.isArray(parsed.rewrites), 'vercel.json must define rewrites array');
  const wildcardRule = parsed.rewrites.find(rule => rule.source === '/(.*)');
  assert.ok(wildcardRule, 'vercel.json must have a wildcard rewrite rule for /(.*)');
  assert.equal(wildcardRule.destination, '/api', 'Wildcard rewrite must point to /api serverless entry point');
});
