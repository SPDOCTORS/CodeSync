/**
 * Tests for applyLanguageRepairs — the pure queue-patch function in sync.ts.
 * Uses the same importTypeScript helper as other adapter tests.
 * No browser globals needed; applyLanguageRepairs is fully side-effect-free.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function importTypeScript(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  // Strip import statements so the module can load without its dependencies.
  const stripped = source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  const output = ts.transpileModule(stripped, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const dataUri = `data:text/javascript;base64,${Buffer.from(output.outputText).toString('base64')}`;
  return import(dataUri);
}

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makeItem(platform, submissionId, language, attempts = 0) {
  return {
    attempts,
    nextAttemptAt: Date.now(),
    submission: { platform, submissionId, language, problemId: 'X1', problemTitle: 'X', sourceCode: 'pass', verdict: 'accepted', submittedAt: new Date().toISOString(), problemUrl: 'https://codeforces.com' },
  };
}

// ── applyLanguageRepairs tests ─────────────────────────────────────────────────

test('applyLanguageRepairs patches Unknown-language CF items from the map', async () => {
  const { applyLanguageRepairs } = await importTypeScript('src/background/sync.ts');
  const queue = [
    makeItem('codeforces', '391737567', 'Unknown'),
    makeItem('codeforces', '392633898', 'Unknown'),
  ];
  const map = { '391737567': 'Python 3', '392633898': 'PyPy 3-64' };
  const { queue: fixed, repaired, details } = applyLanguageRepairs(queue, map);
  assert.equal(repaired, 2);
  assert.equal(fixed[0].submission.language, 'Python 3');
  assert.equal(fixed[1].submission.language, 'PyPy 3-64');
  assert.equal(details['391737567'], 'Python 3');
  assert.equal(details['392633898'], 'PyPy 3-64');
});

test('applyLanguageRepairs skips items whose language is already known', async () => {
  const { applyLanguageRepairs } = await importTypeScript('src/background/sync.ts');
  const queue = [
    makeItem('codeforces', '111', 'Python 3'),  // already known
    makeItem('codeforces', '222', 'Unknown'),
  ];
  const map = { '111': 'GNU C++17', '222': 'Python 3' };
  const { queue: fixed, repaired } = applyLanguageRepairs(queue, map);
  assert.equal(repaired, 1);
  assert.equal(fixed[0].submission.language, 'Python 3',  'existing language must not be overwritten');
  assert.equal(fixed[1].submission.language, 'Python 3');
});

test('applyLanguageRepairs skips non-Codeforces items entirely', async () => {
  const { applyLanguageRepairs } = await importTypeScript('src/background/sync.ts');
  const queue = [
    makeItem('leetcode', '999', 'Unknown'),
    makeItem('codeforces', '123', 'Unknown'),
  ];
  const map = { '999': 'python3', '123': 'Python 3' };
  const { queue: fixed, repaired } = applyLanguageRepairs(queue, map);
  assert.equal(repaired, 1);
  assert.equal(fixed[0].submission.language, 'Unknown', 'leetcode item must be untouched');
  assert.equal(fixed[1].submission.language, 'Python 3');
});

test('applyLanguageRepairs skips CF items not present in the map', async () => {
  const { applyLanguageRepairs } = await importTypeScript('src/background/sync.ts');
  const queue = [ makeItem('codeforces', '555', 'Unknown') ];
  const { queue: fixed, repaired } = applyLanguageRepairs(queue, {});  // empty map
  assert.equal(repaired, 0);
  assert.equal(fixed[0].submission.language, 'Unknown');
});

test('applyLanguageRepairs skips entries where the map value is Unknown', async () => {
  const { applyLanguageRepairs } = await importTypeScript('src/background/sync.ts');
  const queue = [ makeItem('codeforces', '777', 'Unknown') ];
  const { repaired } = applyLanguageRepairs(queue, { '777': 'Unknown' });
  assert.equal(repaired, 0);
});

test('applyLanguageRepairs returns new array instances (does not mutate original)', async () => {
  const { applyLanguageRepairs } = await importTypeScript('src/background/sync.ts');
  const original = [ makeItem('codeforces', '100', 'Unknown') ];
  const { queue: fixed } = applyLanguageRepairs(original, { '100': 'Python 3' });
  assert.notEqual(fixed, original, 'queue array must be a new reference');
  assert.notEqual(fixed[0], original[0], 'patched item must be a new reference');
  assert.equal(original[0].submission.language, 'Unknown', 'original item must not be mutated');
});

test('applyLanguageRepairs preserves source code, attempts, and all other fields', async () => {
  const { applyLanguageRepairs } = await importTypeScript('src/background/sync.ts');
  const item = makeItem('codeforces', '200', 'Unknown', 2);
  item.submission.sourceCode = 'print("hello")';
  item.submission.problemTitle = 'Parity Alternated Deletions';
  const { queue: fixed } = applyLanguageRepairs([item], { '200': 'Python 3' });
  assert.equal(fixed[0].submission.sourceCode, 'print("hello")');
  assert.equal(fixed[0].submission.problemTitle, 'Parity Alternated Deletions');
  assert.equal(fixed[0].attempts, 2);
  assert.equal(fixed[0].submission.language, 'Python 3');
});

test('applyLanguageRepairs handles an empty queue gracefully', async () => {
  const { applyLanguageRepairs } = await importTypeScript('src/background/sync.ts');
  const { queue: fixed, repaired } = applyLanguageRepairs([], { '123': 'Python 3' });
  assert.equal(repaired, 0);
  assert.deepEqual(fixed, []);
});

test('applyLanguageRepairs correctly repairs all 13 real queued CF submissions to Python 3', async () => {
  const { applyLanguageRepairs } = await importTypeScript('src/background/sync.ts');
  const ids = ['391737567','392633898','390167708','391478885','391055787',
                '389946519','389923455','391090511','391188917','391951472',
                '391511310','391050250','391104801'];
  const queue = ids.map(id => makeItem('codeforces', id, 'Unknown'));
  const map = Object.fromEntries(ids.map(id => [id, 'Python 3']));
  const { queue: fixed, repaired, details } = applyLanguageRepairs(queue, map);
  assert.equal(repaired, 13);
  assert.equal(Object.keys(details).length, 13);
  for (const item of fixed) {
    assert.equal(item.submission.language, 'Python 3');
  }
});
