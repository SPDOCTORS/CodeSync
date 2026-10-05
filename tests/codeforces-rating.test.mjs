/**
 * Unit and regression tests for Codeforces problem rating lookup, caching, and path generation.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function importTypeScript(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const dataUri = `data:text/javascript;base64,${Buffer.from(output.outputText).toString('base64')}`;
  return import(dataUri);
}

// ── problemRatingKey tests ───────────────────────────────────────────────────

test('problemRatingKey normalizes contest ID and problem index/ID', async () => {
  const { problemRatingKey } = await importTypeScript('src/lib/codeforces-rating.ts');
  assert.equal(problemRatingKey('1840', 'C'), '1840C');
  assert.equal(problemRatingKey('1840', 'c'), '1840C');
  assert.equal(problemRatingKey('1840', '1840C'), '1840C');
  assert.equal(problemRatingKey(null, '1840C'), '1840C');
  assert.equal(problemRatingKey(undefined, '1840C'), '1840C');
  assert.equal(problemRatingKey(null, ''), null);
});

// ── parseContestRatings tests ────────────────────────────────────────────────

test('parseContestRatings extracts all rated problems from API response', async () => {
  const { parseContestRatings } = await importTypeScript('src/lib/codeforces-rating.ts');
  const mockApiData = {
    status: 'OK',
    result: {
      contest: { id: 1840, name: 'Codeforces Round 878' },
      problems: [
        { contestId: 1840, index: 'A', name: 'Cipher Shifer', rating: 800 },
        { contestId: 1840, index: 'B', name: 'Binary Cafe', rating: 1100 },
        { contestId: 1840, index: 'C', name: 'Ski Resort', rating: 1000 },
        { contestId: 1840, index: 'D', name: 'Wooden Toy Festival', rating: 1500 },
        { contestId: 1840, index: 'E', name: 'Character Blocking' }, // unrated
      ],
    },
  };

  const ratings = parseContestRatings(mockApiData);
  assert.equal(ratings['1840A'], 800);
  assert.equal(ratings['1840B'], 1100);
  assert.equal(ratings['1840C'], 1000);
  assert.equal(ratings['1840D'], 1500);
  assert.equal(ratings['1840E'], undefined);
});

test('parseContestRatings returns empty object on invalid or error API response', async () => {
  const { parseContestRatings } = await importTypeScript('src/lib/codeforces-rating.ts');
  assert.deepEqual(parseContestRatings(null), {});
  assert.deepEqual(parseContestRatings({ status: 'FAILED', comment: 'error' }), {});
  assert.deepEqual(parseContestRatings({ status: 'OK', result: {} }), {});
});

// ── getProblemRating lookup & caching tests ──────────────────────────────────

test('getProblemRating fetches from API on cache miss and caches results', async () => {
  const { getProblemRating } = await importTypeScript('src/lib/codeforces-rating.ts');

  let fetchCalls = 0;
  const mockFetch = async (url) => {
    fetchCalls++;
    return {
      ok: true,
      json: async () => ({
        status: 'OK',
        result: {
          problems: [
            { contestId: 9999, index: 'A', name: 'Easy', rating: 800 },
            { contestId: 9999, index: 'B', name: 'Medium', rating: 1400 },
          ],
        },
      }),
    };
  };

  const ratingA = await getProblemRating('9999', 'A', mockFetch);
  assert.equal(ratingA, 800);
  assert.equal(fetchCalls, 1, 'First call should hit fetch');

  // Second problem from the same contest should hit in-memory cache without fetch
  const ratingB = await getProblemRating('9999', 'B', mockFetch);
  assert.equal(ratingB, 1400);
  assert.equal(fetchCalls, 1, 'Second lookup from same contest must use cache');
});

test('getProblemRating fails safe and returns undefined on network or HTTP error', async () => {
  const { getProblemRating } = await importTypeScript('src/lib/codeforces-rating.ts');

  const errorFetch = async () => {
    throw new Error('Network error / offline');
  };

  const rating = await getProblemRating('8888', 'A', errorFetch);
  assert.equal(rating, undefined, 'Must return undefined on network error without throwing');

  const httpFailFetch = async () => ({
    ok: false,
    status: 500,
  });

  const ratingHttpFail = await getProblemRating('8887', 'A', httpFailFetch);
  assert.equal(ratingHttpFail, undefined, 'Must return undefined on HTTP 500 without throwing');
});

test('getProblemRating returns undefined for missing or invalid contest IDs', async () => {
  const { getProblemRating } = await importTypeScript('src/lib/codeforces-rating.ts');
  assert.equal(await getProblemRating(null, 'A'), undefined);
  assert.equal(await getProblemRating('', 'A'), undefined);
  assert.equal(await getProblemRating('abc', 'A'), undefined);
});

// ── pathFor Codeforces directory tests ───────────────────────────────────────

test('pathFor places rated Codeforces submissions under Codeforces/<rating>/', async () => {
  const { pathFor } = await importTypeScript('src/lib/paths.ts');

  const submission = {
    platform: 'codeforces',
    submissionId: '389946519',
    problemId: '1840C',
    problemTitle: 'Ski Resort',
    language: 'PyPy 3-64',
    sourceCode: 'print(1)',
    verdict: 'accepted',
    submittedAt: '2026-10-01T16:17:38.000Z',
    problemUrl: 'https://codeforces.com/contest/1840/problem/C',
    contest: '1840',
    rating: 1000,
  };

  const path = pathFor(submission);
  assert.equal(path, 'Codeforces/1000/1840C-Ski-Resort-389946519.py');
});

test('pathFor places unrated Codeforces submissions under Codeforces/Unrated/', async () => {
  const { pathFor } = await importTypeScript('src/lib/paths.ts');

  const submissionUnrated = {
    platform: 'codeforces',
    submissionId: '123456',
    problemId: '9999Z',
    problemTitle: 'Unrated Problem',
    language: 'Python 3',
    sourceCode: 'print(1)',
    verdict: 'accepted',
    submittedAt: '2026-10-01T16:17:38.000Z',
    problemUrl: 'https://codeforces.com/contest/9999/problem/Z',
    contest: '9999',
    rating: undefined,
  };

  assert.equal(pathFor(submissionUnrated), 'Codeforces/Unrated/9999Z-Unrated-Problem-123456.py');

  const submissionNull = { ...submissionUnrated, rating: null };
  assert.equal(pathFor(submissionNull), 'Codeforces/Unrated/9999Z-Unrated-Problem-123456.py');
});

test('submissionFromRowData preserves rating parameter', async () => {
  const { submissionFromRowData } = await importTypeScript('src/content/codeforces-adapter.ts');

  const rowData = {
    submissionId: '389946519',
    submissionUrl: 'https://codeforces.com/contest/1840/submission/389946519',
    contestId: '1840',
    problemId: '1840C',
    problemTitle: 'Ski Resort',
    problemUrl: 'https://codeforces.com/contest/1840/problem/C',
    language: 'PyPy 3-64',
    submittedAt: '2026-10-01T16:17:38.000Z',
  };

  const subWithRating = submissionFromRowData(rowData, 'source code', 1000);
  assert.equal(subWithRating.rating, 1000);

  const subWithoutRating = submissionFromRowData(rowData, 'source code');
  assert.equal(subWithoutRating.rating, undefined);
});
