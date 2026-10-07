import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('runConnectionTest uses configured settings repository and records completion', async () => {
  const syncSource = await read('src/background/sync.ts');

  // Verify static absence of hardcoded username
  assert.doesNotMatch(syncSource, /SPDOCTORS/);

  // Set up mock storage
  const storage = {
    settings: {
      enabled: true,
      repository: 'alice/My-CP-Repo',
      authorizationServer: 'https://code-sync-rho-brown.vercel.app',
    },
    completedConnectionTests: [],
  };

  const commits = [];
  const mockService = {
    commit: async (repo, path, content, msg) => {
      commits.push({ repo, path, content, msg });
    },
    listRepositories: async () => [{ full_name: 'alice/My-CP-Repo' }],
  };

  const mockChrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
            const res = {};
            for (const k of keys) res[k] = storage[k];
            return res;
          }
          if (typeof keys === 'string') return { [keys]: storage[keys] };
          return storage;
        },
        set: async (obj) => {
          Object.assign(storage, obj);
        },
      },
    },
    alarms: { create: () => {} },
  };

  const stripped = syncSource
    .replace(/import\s*\{\s*githubService\s*\}\s*from\s*'\.\.\/lib\/github';/, `
      const githubService = async () => mockService;
    `)
    .replace(/import\s*\{\s*pathFor,\s*submissionKey\s*\}\s*from\s*'\.\.\/lib\/paths';/, `
      const pathFor = (s) => 'dummy';
      const submissionKey = (s) => 'dummy';
    `)
    .replace(/import\s*\{\s*getProblemRating\s*\}\s*from\s*'\.\.\/lib\/codeforces-rating';/, `
      const getProblemRating = async () => undefined;
    `);

  const output = ts.transpileModule(stripped, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });

  const runModule = new Function(
    'mockService',
    'chrome',
    `
    const exports = {};
    ${output.outputText}
    return exports;
    `
  );

  const { runConnectionTest } = runModule(mockService, mockChrome);

  // First run: should succeed and commit to alice/My-CP-Repo
  const res1 = await runConnectionTest();
  assert.equal(res1.ok, true);
  assert.equal(res1.message, 'GitHub connection test commit created.');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].repo, 'alice/My-CP-Repo');
  assert.equal(commits[0].path, 'CodeSync-Tests/connection-test.txt');
  assert.deepEqual(storage.completedConnectionTests, ['alice/My-CP-Repo']);

  // Second run: should be blocked as repeat
  const res2 = await runConnectionTest();
  assert.equal(res2.ok, false);
  assert.match(res2.message, /already created the GitHub connection test commit/);
  assert.equal(commits.length, 1, 'Should not have issued a second commit');
});

test('runConnectionTest discovers user repository when settings repository is empty', async () => {
  const syncSource = await read('src/background/sync.ts');

  const storage = {
    settings: {
      enabled: true,
      repository: '',
      authorizationServer: 'https://code-sync-rho-brown.vercel.app',
    },
    completedConnectionTests: [],
  };

  const commits = [];
  const mockService = {
    commit: async (repo, path, content, msg) => {
      commits.push({ repo, path, content, msg });
    },
    listRepositories: async () => [
      { full_name: 'bob/other-repo' },
      { full_name: 'bob/Competitive-Programming' },
    ],
  };

  const mockChrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
            const res = {};
            for (const k of keys) res[k] = storage[k];
            return res;
          }
          if (typeof keys === 'string') return { [keys]: storage[keys] };
          return storage;
        },
        set: async (obj) => {
          Object.assign(storage, obj);
        },
      },
    },
    alarms: { create: () => {} },
  };

  const stripped = syncSource
    .replace(/import\s*\{\s*githubService\s*\}\s*from\s*'\.\.\/lib\/github';/, `
      const githubService = async () => mockService;
    `)
    .replace(/import\s*\{\s*pathFor,\s*submissionKey\s*\}\s*from\s*'\.\.\/lib\/paths';/, `
      const pathFor = (s) => 'dummy';
      const submissionKey = (s) => 'dummy';
    `)
    .replace(/import\s*\{\s*getProblemRating\s*\}\s*from\s*'\.\.\/lib\/codeforces-rating';/, `
      const getProblemRating = async () => undefined;
    `);

  const output = ts.transpileModule(stripped, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });

  const runModule = new Function(
    'mockService',
    'chrome',
    `
    const exports = {};
    ${output.outputText}
    return exports;
    `
  );

  const { runConnectionTest } = runModule(mockService, mockChrome);

  const res = await runConnectionTest();
  assert.equal(res.ok, true);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].repo, 'bob/Competitive-Programming');
  assert.deepEqual(storage.completedConnectionTests, ['bob/Competitive-Programming']);
});
