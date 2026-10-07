import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function importSyncModule() {
  const source = await readFile(new URL('../src/background/sync.ts', import.meta.url), 'utf8');
  // Strip import statements so the module can load without its dependencies
  const stripped = source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  const output = ts.transpileModule(stripped, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const dataUri = `data:text/javascript;base64,${Buffer.from(output.outputText).toString('base64')}`;
  return import(dataUri);
}

test('recordRecentActivity records metadata, keeps newest first, and caps at 20 items', async () => {
  const storage = {};

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
  };

  try {
    const { recordRecentActivity } = await importSyncModule();

    // 1. Record single item
    const sub1 = {
      platform: 'leetcode',
      submissionId: 'sub-001',
      problemId: 'two-sum',
      problemTitle: 'Two Sum',
      language: 'Python 3',
      sourceCode: 'class Solution: ...',
      verdict: 'accepted',
      submittedAt: '2026-10-07T10:00:00Z',
      problemUrl: 'https://leetcode.com/problems/two-sum/',
    };

    await recordRecentActivity(sub1, '2026-10-07T10:00:05Z');

    let recent = storage.recentActivity;
    assert.equal(Array.isArray(recent), true);
    assert.equal(recent.length, 1);
    assert.deepEqual(recent[0], {
      platform: 'leetcode',
      problemId: 'two-sum',
      problemTitle: 'Two Sum',
      submissionId: 'sub-001',
      language: 'Python 3',
      submittedAt: '2026-10-07T10:00:00Z',
      syncedAt: '2026-10-07T10:00:05Z',
      problemUrl: 'https://leetcode.com/problems/two-sum/',
    });

    // 2. Ordering: second item must be first in the array (newest first)
    const sub2 = {
      platform: 'codeforces',
      submissionId: 'sub-002',
      problemId: '4A',
      problemTitle: 'Watermelon',
      language: 'GNU C++17',
      sourceCode: 'int main() {}',
      verdict: 'accepted',
      submittedAt: '2026-10-07T10:05:00Z',
      problemUrl: 'https://codeforces.com/problemset/problem/4/A',
    };

    await recordRecentActivity(sub2, '2026-10-07T10:05:03Z');

    recent = storage.recentActivity;
    assert.equal(recent.length, 2);
    assert.equal(recent[0].submissionId, 'sub-002');
    assert.equal(recent[1].submissionId, 'sub-001');

    // 3. Cap at 20 items: add 25 items in sequence
    for (let i = 3; i <= 25; i++) {
      const sub = {
        platform: 'cses',
        submissionId: `sub-${i.toString().padStart(3, '0')}`,
        problemId: `cses-${i}`,
        problemTitle: `Problem ${i}`,
        language: 'C++',
        sourceCode: '// solution',
        verdict: 'accepted',
        submittedAt: `2026-10-07T10:${i}:00Z`,
        problemUrl: `https://cses.fi/problemset/task/${i}`,
      };
      await recordRecentActivity(sub, `2026-10-07T10:${i}:02Z`);
    }

    recent = storage.recentActivity;
    assert.equal(recent.length, 20, 'History must be capped at 20 items');
    assert.equal(recent[0].submissionId, 'sub-025', 'Newest item must be index 0');
    assert.equal(recent[19].submissionId, 'sub-006', '20th item must be sub-006 (sub-001 through sub-005 dropped)');

    // 4. Handles item without problemUrl safely
    const subNoUrl = {
      platform: 'atcoder',
      submissionId: 'sub-026',
      problemId: 'abc001_1',
      problemTitle: 'Snow Budget',
      language: 'Python',
      sourceCode: 'print(1)',
      verdict: 'accepted',
      submittedAt: '2026-10-07T11:00:00Z',
      problemUrl: '',
    };
    await recordRecentActivity(subNoUrl, '2026-10-07T11:00:02Z');

    recent = storage.recentActivity;
    assert.equal(recent.length, 20);
    assert.equal(recent[0].submissionId, 'sub-026');
    assert.equal(recent[0].problemUrl, undefined);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
