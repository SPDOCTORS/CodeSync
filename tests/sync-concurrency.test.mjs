/**
 * Regression tests for syncQueue concurrency and stale snapshot prevention in sync.ts.
 *
 * Verifies that submissions enqueued while a GitHub commit is in-flight
 * are never overwritten or dropped by stale process() snapshots.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── Static contract tests ──────────────────────────────────────────────────────

test('sync.ts re-reads fresh storage state after a commit before updating queue', async () => {
  const sync = await read('src/background/sync.ts');
  // Must read fresh state after service.commit resolves
  assert.match(
    sync,
    /await service\.commit\([\s\S]*?\);\s*completed\.add\(key\);\s*const fresh = await state\(\);/,
    'process() must re-read state() immediately after commit completes',
  );
  // Must filter the fresh queue by submissionKey, not rely on stale local variable
  assert.match(
    sync,
    /queue = fresh\.queue\.filter\(candidate => submissionKey\(candidate\.submission\) !== key\);/,
    'process() must filter the completed key out of fresh.queue',
  );
});

test('sync.ts re-reads fresh storage state in catch block before recording error', async () => {
  const sync = await read('src/background/sync.ts');
  assert.match(
    sync,
    /catch\s*\([^)]*\)\s*\{[\s\S]*?const fresh = await state\(\);/,
    'catch block must re-read fresh state before recording error on queue item',
  );
});

test('sync.ts serializes enqueueAcceptedSubmission to prevent read-modify-write collisions', async () => {
  const sync = await read('src/background/sync.ts');
  assert.match(
    sync,
    /let enqueuing: Promise<unknown> = Promise\.resolve\(\);/,
    'enqueueAcceptedSubmission must maintain a promise chain for atomic storage appends',
  );
});

// ── Dynamic concurrency simulation test ────────────────────────────────────────

test('simulated concurrent enqueue during in-flight commit preserves all items', async () => {
  // In-memory mock storage representing chrome.storage.local
  const storage = {
    syncQueue: [],
    completedSubmissionKeys: [],
    syncDiagnostics: [],
    settings: {
      enabled: true,
      repository: 'SPDOCTORS/Competitive-Programming',
    },
  };

  // Mock chrome API on globalThis
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
            const res = {};
            for (const k of keys) res[k] = storage[k];
            return res;
          }
          if (typeof keys === 'string') return { [keys]: storage[keys] };
          return { ...storage };
        },
        set: async (obj) => {
          Object.assign(storage, obj);
        },
      },
    },
    alarms: {
      create: () => {},
    },
  };

  try {
    // Transpile sync.ts with a mocked githubService
    const syncSource = await read('src/background/sync.ts');
    
    // Replace the githubService import with an in-memory controllable mock
    let resolveFirstCommit;
    const firstCommitPromise = new Promise(resolve => { resolveFirstCommit = resolve; });

    let commitCount = 0;
    const committedPaths = [];

    // We transpile and bundle with a mocked github module
    const stripped = syncSource
      .replace(/import\s*\{\s*githubService\s*\}\s*from\s*'\.\.\/lib\/github';/, `
        const githubService = async () => ({
          commit: async (repo, path, content, msg) => {
            committedCount++;
            committedPaths.push(path);
            if (committedCount === 1) {
              // Delay the first commit until concurrent items are enqueued
              await commitGate;
            }
          },
        });
      `)
      .replace(/import\s*\{\s*pathFor,\s*submissionKey\s*\}\s*from\s*'\.\.\/lib\/paths';/, `
        const pathFor = (s) => \`\${s.platform}/\${s.submissionId}.txt\`;
        const submissionKey = (s) => \`\${s.platform}:\${s.submissionId}\`;
      `)
      .replace(/import\s*\{\s*getProblemRating\s*\}\s*from\s*'\.\.\/lib\/codeforces-rating';/, `
        const getProblemRating = async () => undefined;
      `);

    const output = ts.transpileModule(stripped, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    });

    const runModule = new Function(
      'committedCount',
      'committedPaths',
      'commitGate',
      'chrome',
      `
      const exports = {};
      ${output.outputText}
      return exports;
      `
    );

    const { enqueueAcceptedSubmission, processQueue } = runModule(
      0,
      committedPaths,
      firstCommitPromise,
      globalThis.chrome,
    );


    // Step 1: Enqueue Item 1 (triggers processQueue, which begins commit 1 and pauses at commitGate)
    const sub1 = {
      platform: 'codeforces',
      submissionId: '101',
      problemId: 'P1',
      problemTitle: 'Problem 1',
      language: 'Python 3',
      sourceCode: 'code1',
      verdict: 'accepted',
      submittedAt: new Date().toISOString(),
      problemUrl: 'https://codeforces.com',
    };

    const p1 = enqueueAcceptedSubmission(sub1);

    // Wait microtask so processQueue begins commit 1
    await new Promise(r => setTimeout(r, 10));

    // Step 2: Concurrently enqueue Item 2 and Item 3 while commit 1 is in-flight
    const sub2 = {
      platform: 'codeforces',
      submissionId: '102',
      problemId: 'P2',
      problemTitle: 'Problem 2',
      language: 'Python 3',
      sourceCode: 'code2',
      verdict: 'accepted',
      submittedAt: new Date().toISOString(),
      problemUrl: 'https://codeforces.com',
    };
    const sub3 = {
      platform: 'codeforces',
      submissionId: '103',
      problemId: 'P3',
      problemTitle: 'Problem 3',
      language: 'Python 3',
      sourceCode: 'code3',
      verdict: 'accepted',
      submittedAt: new Date().toISOString(),
      problemUrl: 'https://codeforces.com',
    };

    await Promise.all([
      enqueueAcceptedSubmission(sub2),
      enqueueAcceptedSubmission(sub3),
    ]);

    // Verify storage has items 2 and 3 registered in syncQueue
    assert.equal(
      storage.syncQueue.some(i => i.submission.submissionId === '102'),
      true,
      'Item 102 must be in storage while commit 1 is in flight',
    );
    assert.equal(
      storage.syncQueue.some(i => i.submission.submissionId === '103'),
      true,
      'Item 103 must be in storage while commit 1 is in flight',
    );

    // Step 3: Now unblock commit 1
    resolveFirstCommit();

    // Wait for queue processing to complete
    await p1;
    await processQueue();

    // Step 4: Verify results:
    // Item 101 must be completed
    assert.equal(
      storage.completedSubmissionKeys.includes('codeforces:101'),
      true,
      'Item 101 must be in completedSubmissionKeys',
    );
    // Items 102 and 103 must either be completed or preserved in syncQueue, NEVER erased!
    const allKnown = new Set([
      ...storage.completedSubmissionKeys,
      ...storage.syncQueue.map(i => `codeforces:${i.submission.submissionId}`),
    ]);

    assert.equal(allKnown.has('codeforces:102'), true, 'Item 102 must NOT be erased');
    assert.equal(allKnown.has('codeforces:103'), true, 'Item 103 must NOT be erased');
  } finally {
    globalThis.chrome = originalChrome;
  }
});
