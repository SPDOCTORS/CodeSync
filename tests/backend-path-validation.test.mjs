import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestHandler, validPath } from '../server/index.mjs';
import { createSessionStore } from '../server/session-store.mjs';
import { Readable } from 'node:stream';

test('validPath allows normal nested repository paths used by all CodeSync platforms', () => {
  const validCases = [
    'LeetCode/Dynamic-Programming/198-house-robber-1234567.py',
    'Codeforces/1400/1234A-equalize-prices-again-2345678.cpp',
    'CodeChef/START100/FLOW001-add-two-numbers-3456789.java',
    'CSES/Sorting-and-Searching/1621-distinct-numbers-4567890.rs',
    'AtCoder/abc300/abc300_a-n-choice-question-5678901.py',
    'CodeSync-Tests/connection-test.txt',
    'solutions/math/gcd.cpp',
    '198..house-robber.py',
    'a/b/c/d/e/file.txt',
  ];

  for (const path of validCases) {
    assert.equal(validPath(path), true, `Expected valid path: "${path}"`);
  }
});

test('validPath rejects empty and whitespace-only paths', () => {
  const invalidCases = ['', '   ', '\t', '\n', '  \r\n  '];
  for (const path of invalidCases) {
    assert.equal(validPath(path), false, `Expected rejected empty/whitespace path: "${path}"`);
  }
});

test('validPath rejects leading and trailing whitespace', () => {
  assert.equal(validPath(' LeetCode/test.py'), false);
  assert.equal(validPath('LeetCode/test.py '), false);
  assert.equal(validPath('\tLeetCode/test.py'), false);
});

test('validPath rejects absolute paths and paths starting with / or \\', () => {
  const invalidCases = [
    '/LeetCode/198.py',
    '/etc/passwd',
    '/',
    '//LeetCode/198.py',
    '\\LeetCode\\198.py',
    '\\windows\\win.ini',
  ];
  for (const path of invalidCases) {
    assert.equal(validPath(path), false, `Expected rejected absolute path: "${path}"`);
  }
});

test('validPath rejects paths with segments equal to ".." or "."', () => {
  const invalidCases = [
    '..',
    '../test.py',
    'LeetCode/../secret.py',
    'LeetCode/Dynamic-Programming/../../../passwd',
    'foo/bar/..',
    '.',
    './test.py',
    'LeetCode/./test.py',
    'foo/bar/.',
    'foo/%2e%2e/bar.py',
    '%2e%2e/foo.py',
    'foo/%2e/bar.py',
  ];
  for (const path of invalidCases) {
    assert.equal(validPath(path), false, `Expected rejected traversal path: "${path}"`);
  }
});

test('validPath rejects backslash-based traversal and paths with backslashes', () => {
  const invalidCases = [
    '..\\test.py',
    'LeetCode\\test.py',
    'LeetCode\\..\\secret.py',
    'foo\\bar',
    'foo/..\\bar',
  ];
  for (const path of invalidCases) {
    assert.equal(validPath(path), false, `Expected rejected backslash path: "${path}"`);
  }
});

test('validPath rejects empty segments, consecutive slashes, and trailing slashes', () => {
  assert.equal(validPath('LeetCode//test.py'), false);
  assert.equal(validPath('LeetCode/test.py/'), false);
  assert.equal(validPath('foo///bar.py'), false);
});

test('HTTP handler: PUT /contents returns 400 for invalid/traversal paths without calling GitHub', async () => {
  const store = createSessionStore({ fallbackToMemory: true });
  const sessionToken = await store.createSession('gho_dummy_token', 3600);

  let gitHubCalled = false;
  const mockFetch = async () => {
    gitHubCalled = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const handler = createRequestHandler({
    baseUrl: 'http://localhost:8787',
    store,
    fetchFn: mockFetch,
  });

  const rejectedPaths = [
    '../traversal.py',
    '/absolute/path.py',
    'LeetCode/../../etc/passwd',
    'foo\\..\\bar.py',
    '   ',
    'foo//bar.py',
  ];

  for (const badPath of rejectedPaths) {
    gitHubCalled = false;
    let statusCode = null;
    let responseBody = '';

    const reqPayload = JSON.stringify({
      path: badPath,
      content: 'print(1)',
      message: 'test commit',
    });

    const stream = Readable.from([Buffer.from(reqPayload)]);
    stream.method = 'PUT';
    stream.url = '/v1/github/repos/test-owner%2Ftest-repo/contents';
    stream.headers = {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json',
    };

    const res = {
      writeHead(status) {
        statusCode = status;
      },
      end(data) {
        responseBody = data;
      },
    };

    await handler(stream, res);
    assert.equal(statusCode, 400, `Expected 400 for path "${badPath}", got ${statusCode}`);
    const parsed = JSON.parse(responseBody);
    assert.equal(parsed.error, 'Invalid file path.');
    assert.equal(gitHubCalled, false, `GitHub API must not be called for rejected path "${badPath}"`);
  }
});

test('HTTP handler: PUT /contents accepts valid nested platform paths', async () => {
  const store = createSessionStore({ fallbackToMemory: true });
  const sessionToken = await store.createSession('gho_dummy_token', 3600);

  const calls = [];
  const mockFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (opts?.method === 'PUT') {
      return { ok: true, status: 201, json: async () => ({ ok: true }) };
    }
    // Existing SHA lookup GET
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const handler = createRequestHandler({
    baseUrl: 'http://localhost:8787',
    store,
    fetchFn: mockFetch,
  });

  const validPathCase = 'LeetCode/Dynamic-Programming/198-house-robber-1234567.py';
  const reqPayload = JSON.stringify({
    path: validPathCase,
    content: 'print("accepted")',
    message: 'Accepted: LeetCode - 198',
  });

  const stream = Readable.from([Buffer.from(reqPayload)]);
  stream.method = 'PUT';
  stream.url = '/v1/github/repos/test-owner%2Ftest-repo/contents';
  stream.headers = {
    authorization: `Bearer ${sessionToken}`,
    'content-type': 'application/json',
  };

  let statusCode = null;
  let responseBody = '';
  const res = {
    writeHead(status) {
      statusCode = status;
    },
    end(data) {
      responseBody = data;
    },
  };

  await handler(stream, res);
  assert.equal(statusCode, 201);
  const parsed = JSON.parse(responseBody);
  assert.equal(parsed.ok, true);
  assert.ok(calls.length >= 1, 'GitHub API should have been invoked for valid path');
});
