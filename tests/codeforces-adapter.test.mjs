import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Reuse the same TypeScript-transpile helper from leetcode-adapter.test.mjs
async function importTypeScript(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

// ── Lightweight DOM stub ───────────────────────────────────────────────────────

/**
 * Simulates the Element API subset used by isAcceptedRow, submissionIdFromRow,
 * and acceptedIdsFromTable without requiring JSDOM.
 */
class RowStub {
  constructor(html) { this._html = html; }

  querySelector(selector) {
    if (selector === '.verdict-accepted') {
      return /class="[^"]*verdict-accepted[^"]*"/.test(this._html)
        ? { textContent: 'Accepted' } : null;
    }
    if (selector === '.status-verdict-cell, td.status-small') {
      const m = this._html.match(
        /<td[^>]*class="[^"]*(?:status-verdict-cell|status-small)[^"]*"[^>]*>([\s\S]*?)<\/td>/i
      );
      if (!m) return null;
      return { textContent: m[1].replace(/<[^>]+>/g, '').trim() };
    }
    if (selector === 'a[href*="/submission/"]') {
      const m = this._html.match(/<a[^>]+href="([^"]*\/submission\/[^"]*)"[^>]*>/i);
      if (!m) return null;
      const raw = m[1];
      const href = raw.startsWith('/') ? `https://codeforces.com${raw}` : raw;
      return { href };
    }
    return null;
  }

  querySelectorAll() { return []; }

  get dataset() {
    const m = this._html.match(/data-submission-id="(\d+)"/);
    return { submissionId: m?.[1] };
  }
}

// ── isAcceptedRow ─────────────────────────────────────────────────────────────

test('isAcceptedRow detects .verdict-accepted CSS class (modern Codeforces)', async () => {
  const { isAcceptedRow } = await importTypeScript('src/content/codeforces-adapter.ts');
  const row = new RowStub('<tr><td><span class="verdict-accepted">Accepted</span></td></tr>');
  assert.equal(isAcceptedRow(row), true);
});

test('isAcceptedRow detects "Accepted" text in status-verdict-cell (older pages)', async () => {
  const { isAcceptedRow } = await importTypeScript('src/content/codeforces-adapter.ts');
  const row = new RowStub('<tr><td class="status-verdict-cell">Accepted</td></tr>');
  assert.equal(isAcceptedRow(row), true);
});

test('isAcceptedRow detects "OK" text in status-small (gym/older contest pages)', async () => {
  const { isAcceptedRow } = await importTypeScript('src/content/codeforces-adapter.ts');
  const row = new RowStub('<tr><td class="status-small">OK</td></tr>');
  assert.equal(isAcceptedRow(row), true);
});

test('isAcceptedRow is case-insensitive for both accepted and ok verdicts', async () => {
  const { isAcceptedRow } = await importTypeScript('src/content/codeforces-adapter.ts');
  assert.equal(isAcceptedRow(new RowStub('<tr><td class="status-verdict-cell">ACCEPTED</td></tr>')), true);
  assert.equal(isAcceptedRow(new RowStub('<tr><td class="status-small">Ok</td></tr>')), true);
});

test('isAcceptedRow rejects Wrong Answer, TLE, and other non-accepted verdicts', async () => {
  const { isAcceptedRow } = await importTypeScript('src/content/codeforces-adapter.ts');
  assert.equal(isAcceptedRow(new RowStub('<tr><td class="status-verdict-cell">Wrong answer on test 3</td></tr>')), false);
  assert.equal(isAcceptedRow(new RowStub('<tr><td class="status-verdict-cell">Time limit exceeded</td></tr>')), false);
  assert.equal(isAcceptedRow(new RowStub('<tr><td>Pending</td></tr>')), false);
});

test('isAcceptedRow does not match "Not accepted" as a substring of "accepted"', async () => {
  const { isAcceptedRow } = await importTypeScript('src/content/codeforces-adapter.ts');
  // ACCEPTED_VERDICTS uses Set.has(), so only exact lowercase matches pass
  assert.equal(isAcceptedRow(new RowStub('<tr><td class="status-verdict-cell">Not accepted</td></tr>')), false);
});

// ── submissionIdFromRow ───────────────────────────────────────────────────────

test('submissionIdFromRow extracts ID from /contest/.../submission/... href', async () => {
  const { submissionIdFromRow } = await importTypeScript('src/content/codeforces-adapter.ts');
  const row = new RowStub('<tr><td><a href="/contest/1999/submission/274503821">274503821</a></td></tr>');
  assert.equal(submissionIdFromRow(row), '274503821');
});

test('submissionIdFromRow extracts ID from /problemset/submission/.../... href', async () => {
  const { submissionIdFromRow } = await importTypeScript('src/content/codeforces-adapter.ts');
  const row = new RowStub('<tr><td><a href="/problemset/submission/tourist/123456789">123456789</a></td></tr>');
  assert.equal(submissionIdFromRow(row), '123456789');
});

test('submissionIdFromRow returns null when no submission link is present', async () => {
  const { submissionIdFromRow } = await importTypeScript('src/content/codeforces-adapter.ts');
  const row = new RowStub('<tr><td><a href="/profile/tourist">tourist</a></td></tr>');
  assert.equal(submissionIdFromRow(row), null);
});

// ── isSubmissionsPage ─────────────────────────────────────────────────────────

test('isSubmissionsPage matches all known Codeforces submission URL patterns', async () => {
  const { isSubmissionsPage } = await importTypeScript('src/content/codeforces-adapter.ts');
  const matching = [
    '/contest/1999/my',
    '/contest/1999/my/',
    '/gym/104941/my',
    '/problemset/status/tourist',
    '/submissions/tourist',
    '/profile/tourist',
  ];
  for (const pathname of matching) {
    assert.equal(isSubmissionsPage(pathname), true, `Expected match for ${pathname}`);
  }
});

test('isSubmissionsPage does not match problem, blog, or standings pages', async () => {
  const { isSubmissionsPage } = await importTypeScript('src/content/codeforces-adapter.ts');
  const nonMatching = [
    '/problemset/problem/1/A',
    '/contest/1999/problem/A',
    '/contest/1999/standings',
    '/blog/entry/12345',
    '/group/abc/contest/1234',
  ];
  for (const pathname of nonMatching) {
    assert.equal(isSubmissionsPage(pathname), false, `Expected no match for ${pathname}`);
  }
});

// ── Phase 3: sourceCodeFromHtml ───────────────────────────────────────────────

test('sourceCodeFromHtml extracts source from <pre id="program-source-text">', async () => {
  const { sourceCodeFromHtml } = await importTypeScript('src/content/codeforces-adapter.ts');
  const html = `<html><body>
    <pre id="program-source-text" class="prettyprint">def solve():
    print("hello")</pre>
  </body></html>`;
  assert.equal(sourceCodeFromHtml(html), 'def solve():\n    print("hello")');
});

test('sourceCodeFromHtml decodes HTML entities in source code', async () => {
  const { sourceCodeFromHtml } = await importTypeScript('src/content/codeforces-adapter.ts');
  const html = `<pre id="program-source-text">if (a &lt; b &amp;&amp; c &gt; d) { x = &quot;hi&quot;; }</pre>`;
  assert.equal(sourceCodeFromHtml(html), 'if (a < b && c > d) { x = "hi"; }');
});

test('sourceCodeFromHtml falls back to first <pre class="prettyprint"> when id is absent', async () => {
  const { sourceCodeFromHtml } = await importTypeScript('src/content/codeforces-adapter.ts');
  const html = `<html><body>
    <pre class="prettyprint linenums">int main() { return 0; }</pre>
  </body></html>`;
  assert.equal(sourceCodeFromHtml(html), 'int main() { return 0; }');
});

test('sourceCodeFromHtml returns null when no source block is found', async () => {
  const { sourceCodeFromHtml } = await importTypeScript('src/content/codeforces-adapter.ts');
  assert.equal(sourceCodeFromHtml('<html><body><p>No code here</p></body></html>'), null);
  assert.equal(sourceCodeFromHtml(''), null);
});

test('sourceCodeFromHtml returns null for an empty source block', async () => {
  const { sourceCodeFromHtml } = await importTypeScript('src/content/codeforces-adapter.ts');
  assert.equal(sourceCodeFromHtml('<pre id="program-source-text">   </pre>'), null);
});

// ── htmlDecode ────────────────────────────────────────────────────────────────

test('htmlDecode handles all common HTML entities and numeric codes', async () => {
  const { htmlDecode } = await importTypeScript('src/content/codeforces-adapter.ts');
  assert.equal(htmlDecode('&lt;&gt;&amp;&quot;&#39;'), `<>&"'`);
  assert.equal(htmlDecode('&#65;&#66;&#67;'), 'ABC');
  assert.equal(htmlDecode('no entities here'), 'no entities here');
});

// ── parseCodeforcesDate ───────────────────────────────────────────────────────

test('parseCodeforcesDate converts Sep/30/2024 17:30:45 format to ISO 8601', async () => {
  const { parseCodeforcesDate } = await importTypeScript('src/content/codeforces-adapter.ts');
  const iso = parseCodeforcesDate('Sep/30/2024 17:30:45');
  assert.ok(iso.startsWith('2024-09-30'), `Got: ${iso}`);
  assert.ok(iso.includes('T'), 'Should be ISO 8601 with T separator');
});

test('parseCodeforcesDate falls back to current time for unrecognised formats', async () => {
  const { parseCodeforcesDate } = await importTypeScript('src/content/codeforces-adapter.ts');
  const before = Date.now();
  const iso = parseCodeforcesDate('not a date');
  const after = Date.now();
  const parsed = new Date(iso).getTime();
  assert.ok(parsed >= before && parsed <= after, 'Should fall back to current time');
});

// ── rowDataFromElement ────────────────────────────────────────────────────────

/**
 * Lightweight row stub that covers the selectors used by rowDataFromElement.
 * Cells are passed as an array of plain strings for the language scanner.
 */
function makeRow({ submHref, probHref = '', probText = '', cells = [], dataSubmId = null }) {
  const makeLink = (href, text) => ({
    href: href.startsWith('http') ? href : `https://codeforces.com${href}`,
    getAttribute: () => href,
    textContent: text,
    querySelector: () => null,
  });

  return {
    querySelector(selector) {
      if (selector === 'a[href*="/submission/"]') return submHref ? makeLink(submHref, '') : null;
      if (selector === 'a[href*="/problem/"]')    return probHref ? makeLink(probHref, probText) : null;
      if (selector === 'span[data-timestamp], td[data-timestamp]') return null;
      if (selector === 'span.format-time') return null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== 'td') return [];
      return cells.map(text => ({
        textContent: text,
        // Each cell exposes querySelector so the positional language lookup
        // can identify the problem-link cell (cells[probIdx]) via
        // cell.querySelector('a[href*="/problem/"]').
        querySelector: (sel) => {
          if (sel === 'a[href*="/problem/"]' && probHref && text === probText)
            return makeLink(probHref, probText);
          return null;
        },
        dataset: {},
      }));
    },
    dataset: { submissionId: dataSubmId },
  };
}


test('rowDataFromElement extracts contest submission metadata correctly', async () => {
  const { rowDataFromElement } = await importTypeScript('src/content/codeforces-adapter.ts');
  const row = makeRow({
    submHref: '/contest/1999/submission/274503821',
    probHref: '/contest/1999/problem/A',
    probText: 'A. Greeting',
    cells: ['274503821', 'Sep/30/2024 17:30:45', 'tourist', 'A. Greeting', 'GNU C++17', 'Accepted', '15 ms', '256 MB'],
  });
  const data = rowDataFromElement(row, 'https://codeforces.com');
  assert.equal(data?.submissionId, '274503821');
  assert.equal(data?.contestId, '1999');
  assert.equal(data?.problemId, '1999A');
  assert.equal(data?.problemTitle, 'Greeting');
  assert.equal(data?.language, 'GNU C++17');
  assert.equal(data?.submissionUrl, 'https://codeforces.com/contest/1999/submission/274503821');
  assert.equal(data?.problemUrl, 'https://codeforces.com/contest/1999/problem/A');
});

test('rowDataFromElement handles problemset submission URL pattern', async () => {
  const { rowDataFromElement } = await importTypeScript('src/content/codeforces-adapter.ts');
  const row = makeRow({
    submHref: '/problemset/submission/tourist/123456789',
    cells: ['Python 3', '150 ms'],
  });
  const data = rowDataFromElement(row, 'https://codeforces.com');
  assert.equal(data?.submissionId, '123456789');
  assert.equal(data?.contestId, null);
  assert.equal(data?.language, 'Python 3');
});

test('rowDataFromElement returns null when no submission link is present', async () => {
  const { rowDataFromElement } = await importTypeScript('src/content/codeforces-adapter.ts');
  const row = makeRow({ submHref: '' });
  assert.equal(rowDataFromElement(row, 'https://codeforces.com'), null);
});

test('rowDataFromElement strips index prefix from problem title', async () => {
  const { rowDataFromElement } = await importTypeScript('src/content/codeforces-adapter.ts');
  for (const [raw, expected] of [
    ['A. Two Sum', 'Two Sum'],
    ['B1 - Hard Version', 'Hard Version'],
    ['C – Another Problem', 'Another Problem'],
  ]) {
    const row = makeRow({
      submHref: '/contest/1/submission/1',
      probHref: '/contest/1/problem/A',
      probText: raw,
    });
    const data = rowDataFromElement(row, 'https://codeforces.com');
    assert.equal(data?.problemTitle, expected, `Expected "${expected}" for raw "${raw}"`);
  }
});

// ── submissionFromRowData ─────────────────────────────────────────────────────

test('submissionFromRowData builds a complete Submission for the sync queue', async () => {
  const { submissionFromRowData } = await importTypeScript('src/content/codeforces-adapter.ts');
  const data = {
    submissionId: '274503821',
    submissionUrl: 'https://codeforces.com/contest/1999/submission/274503821',
    contestId: '1999',
    problemId: '1999A',
    problemTitle: 'Greeting',
    problemUrl: 'https://codeforces.com/contest/1999/problem/A',
    language: 'GNU C++17',
    submittedAt: '2024-09-30T12:00:00.000Z',
  };
  const submission = submissionFromRowData(data, '#include <bits/stdc++.h>');
  assert.equal(submission.platform, 'codeforces');
  assert.equal(submission.submissionId, '274503821');
  assert.equal(submission.problemId, '1999A');
  assert.equal(submission.problemTitle, 'Greeting');
  assert.equal(submission.language, 'GNU C++17');
  assert.equal(submission.sourceCode, '#include <bits/stdc++.h>');
  assert.equal(submission.verdict, 'accepted');
  assert.equal(submission.contest, '1999');
  assert.equal(submission.submittedAt, '2024-09-30T12:00:00.000Z');
});

test('submissionFromRowData uses fallback problemUrl when row had no problem link', async () => {
  const { submissionFromRowData } = await importTypeScript('src/content/codeforces-adapter.ts');
  const sub = submissionFromRowData(
    { submissionId: '1', submissionUrl: '', contestId: null, problemId: '1', problemTitle: 'X', problemUrl: '', language: 'Python 3', submittedAt: new Date().toISOString() },
    'pass'
  );
  assert.equal(sub.problemUrl, 'https://codeforces.com');
  assert.equal(sub.contest, undefined);
});


// ── Language extraction regression tests ─────────────────────────────────────
//
// These tests guard against the bug where extractLanguage returned 'Unknown'
// on the /submissions/<handle> page because Codeforces wraps language names
// in filter-anchor tags (<a href="?lang=54">PyPy 3-64</a>), and the old code
// had `!cell.querySelector('a')` which excluded every language cell.
// The fix uses positional lookup (cell after the problem-link cell) so anchors
// are irrelevant, then falls back to LANGUAGE_RE without the anchor guard.

test('extractLanguage (via rowDataFromElement): Python 3 — plain cell', async () => {
  const { rowDataFromElement } = await importTypeScript('src/content/codeforces-adapter.ts');
  const row = makeRow({
    submHref: '/contest/1607/submission/389923455',
    probHref: '/contest/1607/problem/B',
    probText: 'B. Odd Grasshopper',
    cells: ['389923455', 'Oct/01/2026', 'tourist', 'B. Odd Grasshopper', 'Python 3', 'Accepted', '77 ms', '256 MB'],
  });
  const data = rowDataFromElement(row, 'https://codeforces.com');
  assert.equal(data?.language, 'Python 3');
});

test('extractLanguage (via rowDataFromElement): PyPy 3-64 — was broken by anchor guard', async () => {
  const { rowDataFromElement } = await importTypeScript('src/content/codeforces-adapter.ts');
  // This is the exact layout of /submissions/<handle> where the language cell
  // contains an anchor link; positional lookup reads textContent regardless.
  const row = makeRow({
    submHref: '/contest/1896/submission/391889278',
    probHref: '/contest/1896/problem/B',
    probText: 'B. AB Flipping',
    cells: ['391889278', 'Oct/01/2026', 'tourist', 'B. AB Flipping', 'PyPy 3-64', 'Accepted', '31 ms', '0.51 MB'],
  });
  const data = rowDataFromElement(row, 'https://codeforces.com');
  assert.equal(data?.language, 'PyPy 3-64');
});

test('extractLanguage (via rowDataFromElement): GNU C++17 (64)', async () => {
  const { rowDataFromElement } = await importTypeScript('src/content/codeforces-adapter.ts');
  const row = makeRow({
    submHref: '/contest/1999/submission/274503821',
    probHref: '/contest/1999/problem/A',
    probText: 'A. Greeting',
    cells: ['274503821', 'Oct/01/2026', 'tourist', 'A. Greeting', 'GNU C++17 (64)', 'Accepted', '15 ms', '256 MB'],
  });
  const data = rowDataFromElement(row, 'https://codeforces.com');
  assert.equal(data?.language, 'GNU C++17 (64)');
});

test('extractLanguage (via rowDataFromElement): Java 21', async () => {
  const { rowDataFromElement } = await importTypeScript('src/content/codeforces-adapter.ts');
  const row = makeRow({
    submHref: '/contest/2000/submission/399999999',
    probHref: '/contest/2000/problem/C',
    probText: 'C. Hard Problem',
    cells: ['399999999', 'Oct/03/2026', 'tourist', 'C. Hard Problem', 'Java 21', 'Accepted', '201 ms', '512 MB'],
  });
  const data = rowDataFromElement(row, 'https://codeforces.com');
  assert.equal(data?.language, 'Java 21');
});

test('extractLanguage: LANGUAGE_RE fallback fires when no problem link is present', async () => {
  const { rowDataFromElement } = await importTypeScript('src/content/codeforces-adapter.ts');
  // No probHref → positional lookup skipped; LANGUAGE_RE must pick up "Kotlin 1.7".
  const row = makeRow({
    submHref: '/contest/1/submission/1',
    probHref: '',
    probText: '',
    cells: ['1', 'Oct/03/2026', 'tourist', 'A. Title', 'Kotlin 1.7', 'Accepted', '55 ms', '256 MB'],
  });
  const data = rowDataFromElement(row, 'https://codeforces.com');
  assert.equal(data?.language, 'Kotlin 1.7');
});

test('extractLanguage: returns Unknown when no language can be detected', async () => {
  const { rowDataFromElement } = await importTypeScript('src/content/codeforces-adapter.ts');
  // No problem link and no recognisable language text in any cell.
  const row = makeRow({
    submHref: '/contest/1/submission/1',
    cells: ['1', '01-01-2024', 'user', 'A. Title', '???', 'Accepted', '15 ms', '256 MB'],
  });
  const data = rowDataFromElement(row, 'https://codeforces.com');
  assert.equal(data?.language, 'Unknown');
});
