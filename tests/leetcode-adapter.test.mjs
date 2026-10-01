import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function importTypeScript(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

const accepted = { id: 12345, question_id: 1, title: 'Two Sum', title_slug: 'two-sum', lang: 'python3', code: 'class Solution:\n    pass', status_code: 10, status_msg: 'Accepted', timestamp: 1_700_000_000 };

test('Accepted details create a LeetCode submission with deterministic primary topic', async () => {
  const { submissionFromDetail } = await importTypeScript('src/content/leetcode-adapter.ts');
  const submission = submissionFromDetail(accepted, [{ name: 'Array' }, { name: 'Hash Table' }]);
  assert.equal(submission?.verdict, 'accepted');
  assert.equal(submission?.submissionId, '12345');
  assert.equal(submission?.topic, 'Array');
  assert.equal(submission?.sourceCode, accepted.code);
});

test('signed-in GraphQL submission details provide the submitted source and topic metadata', async () => {
  const { detailFromGraphql, submissionFromDetail } = await importTypeScript('src/content/leetcode-adapter.ts');
  const normalized = detailFromGraphql({ id: 2158128956, code: accepted.code, timestamp: accepted.timestamp, statusCode: 10, lang: { name: 'python3' }, question: { questionId: '1', title: 'Two Sum', titleSlug: 'two-sum', topicTags: [{ name: 'Array' }] } });
  const submission = submissionFromDetail(normalized.detail, normalized.topicTags);
  assert.equal(submission?.submissionId, '2158128956');
  assert.equal(submission?.sourceCode, accepted.code);
  assert.equal(submission?.topic, 'Array');
});

test('Wrong Answer details are never converted into a queued submission', async () => {
  const { submissionFromDetail } = await importTypeScript('src/content/leetcode-adapter.ts');
  assert.equal(submissionFromDetail({ ...accepted, status_code: 11, status_msg: 'Wrong Answer' }, [{ name: 'Array' }]), null);
});

test('missing topic metadata uses Uncategorized and duplicate IDs retain one queue key', async () => {
  const [{ submissionFromDetail }, { submissionKey }] = await Promise.all([importTypeScript('src/content/leetcode-adapter.ts'), importTypeScript('src/lib/paths.ts')]);
  const submission = submissionFromDetail(accepted);
  assert.equal(submission?.topic, 'Uncategorized');
  assert.equal(submissionKey(submission), submissionKey({ ...submission, problemTitle: 'Changed title after refresh' }));
});

test('Accepted details with missing source code are never queued', async () => {
  const { submissionFromDetail } = await importTypeScript('src/content/leetcode-adapter.ts');
  assert.equal(submissionFromDetail({ ...accepted, code: '' }, [{ name: 'Array' }]), null);
});

test('history response parsing accepts nested and top-level pagination with numeric or string Accepted status', async () => {
  const { historyPageFromResponse, isAcceptedHistoryRecord } = await importTypeScript('src/content/leetcode-adapter.ts');
  const nested = historyPageFromResponse({ data: { submissions_dump: [{ id: 1, status: '10' }, { id: 2, status_display: 'Accepted' }], lastKey: 'cursor-2' } });
  assert.equal(nested.rows.length, 2);
  assert.equal(nested.nextKey, 'cursor-2');
  assert.equal(isAcceptedHistoryRecord(nested.rows[0]), true);
  assert.equal(isAcceptedHistoryRecord(nested.rows[1]), true);
  const topLevel = historyPageFromResponse({ submissions: [{ id: 3, status: 11 }], last_key: 'cursor-3' });
  assert.equal(topLevel.nextKey, 'cursor-3');
  assert.equal(isAcceptedHistoryRecord(topLevel.rows[0]), false);
});
