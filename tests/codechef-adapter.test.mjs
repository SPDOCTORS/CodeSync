import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function importTypeScript(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

// ── Lightweight DOM stub for tests without JSDOM ──────────────────────────────

class SimpleElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.children = [];
    this._textContent = '';
    this.dataset = {};
    for (const [k, v] of Object.entries(attributes)) {
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[camel] = v;
      }
    }
  }

  get textContent() {
    let t = this._textContent;
    for (const c of this.children) {
      t += c.textContent;
    }
    return t;
  }

  set textContent(val) {
    this._textContent = val;
  }

  getAttribute(name) {
    return this.attributes[name.toLowerCase()] ?? null;
  }

  get value() {
    return this.attributes['value'] ?? '';
  }

  querySelector(sel) {
    const list = this.querySelectorAll(sel);
    return list[0] ?? null;
  }

  querySelectorAll(sel) {
    const parts = sel.split(',').map(s => s.trim());
    const matchesSingle = (elem, s) => {
      const tagMatch = s.match(/^[a-zA-Z0-9-]+/);
      if (tagMatch && elem.tagName !== tagMatch[0].toUpperCase()) {
        return false;
      }

      const classMatch = s.match(/\.([a-zA-Z0-9_-]+)/);
      if (classMatch) {
        const cls = elem.attributes['class'] || '';
        const classes = cls.split(/\s+/);
        if (!classes.includes(classMatch[1])) return false;
      }

      const idMatch = s.match(/#([a-zA-Z0-9_-]+)/);
      if (idMatch) {
        if (elem.attributes['id'] !== idMatch[1]) return false;
      }

      const attrSubMatch = s.match(/\[([a-zA-Z0-9_:-]+)\*=([\"']?)(.*?)\2\]/);
      if (attrSubMatch) {
        const attrVal = elem.attributes[attrSubMatch[1].toLowerCase()] ?? '';
        if (!attrVal.includes(attrSubMatch[3])) return false;
      }

      const attrExactMatch = s.match(/\[([a-zA-Z0-9_:-]+)=([\"']?)(.*?)\2\]/);
      if (attrExactMatch && !attrSubMatch) {
        const attrVal = elem.attributes[attrExactMatch[1].toLowerCase()] ?? '';
        if (attrVal !== attrExactMatch[3]) return false;
      }

      const attrExistMatch = s.match(/\[([a-zA-Z0-9_:-]+)\]/);
      if (attrExistMatch && !attrSubMatch && !attrExactMatch) {
        if (!(attrExistMatch[1].toLowerCase() in elem.attributes)) return false;
      }

      return true;
    };

    const results = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (parts.some(p => matchesSingle(child, p))) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

function parseHtml(html) {
  const tagRe = /<\/?([a-zA-Z0-9-]+)((?:\s+[a-zA-Z0-9_:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  const root = new SimpleElement('div');
  const stack = [root];

  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const [full, tagName, attrStr, selfClosing, textContent] = match;
    if (textContent) {
      const parent = stack[stack.length - 1];
      parent.textContent += textContent;
      continue;
    }

    if (full.startsWith('</')) {
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }

    const attrs = {};
    if (attrStr) {
      const attrRe = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let aMatch;
      while ((aMatch = attrRe.exec(attrStr)) !== null) {
        const key = aMatch[1].toLowerCase();
        const val = aMatch[2] ?? aMatch[3] ?? aMatch[4] ?? '';
        attrs[key] = val;
      }
    }

    const elem = new SimpleElement(tagName, attrs);
    const parent = stack[stack.length - 1];
    parent.children.push(elem);

    const isVoid = /^(img|input|br|hr|meta|link)$/i.test(tagName) || Boolean(selfClosing);
    if (!isVoid) {
      stack.push(elem);
    }
  }

  return root.children.length === 1 ? root.children[0] : root;
}

// ── parseProblemUrl tests ─────────────────────────────────────────────────────

test('parseProblemUrl extracts practice problem info from standard practice URLs', async () => {
  const { parseProblemUrl } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.deepEqual(parseProblemUrl('https://www.codechef.com/problems/FLOW001'), {
    contestId: 'Practice',
    problemCode: 'FLOW001',
  });

  assert.deepEqual(parseProblemUrl('https://www.codechef.com/problems/FLOW001/'), {
    contestId: 'Practice',
    problemCode: 'FLOW001',
  });

  assert.deepEqual(parseProblemUrl('https://www.codechef.com/problems/FLOW001?tab=statement#hint'), {
    contestId: 'Practice',
    problemCode: 'FLOW001',
  });

  assert.deepEqual(parseProblemUrl('/problems/START01'), {
    contestId: 'Practice',
    problemCode: 'START01',
  });
});

test('parseProblemUrl extracts contest problem info from contest URLs', async () => {
  const { parseProblemUrl } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.deepEqual(parseProblemUrl('https://www.codechef.com/START154C/problems/XYZ'), {
    contestId: 'START154C',
    problemCode: 'XYZ',
  });

  assert.deepEqual(parseProblemUrl('https://www.codechef.com/contest/START154C/problems/XYZ/'), {
    contestId: 'START154C',
    problemCode: 'XYZ',
  });

  assert.deepEqual(parseProblemUrl('/LTIME100/problems/MAX_DIFF?tab=submissions'), {
    contestId: 'LTIME100',
    problemCode: 'MAX_DIFF',
  });
});

test('parseProblemUrl extracts problem info from practice course URLs', async () => {
  const { parseProblemUrl } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.deepEqual(parseProblemUrl('https://www.codechef.com/practice/course/basic-programming/BP001/problems/ABC'), {
    contestId: 'Practice',
    problemCode: 'ABC',
  });

  assert.deepEqual(parseProblemUrl('/practice/course/python-beginner/PY01/problems/PYTH01?tab=ide#submission'), {
    contestId: 'Practice',
    problemCode: 'PYTH01',
  });
});

test('parseProblemUrl returns null for non-problem URLs or empty input', async () => {
  const { parseProblemUrl } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.equal(parseProblemUrl(''), null);
  assert.equal(parseProblemUrl('https://www.codechef.com/status/FLOW001'), null);
  assert.equal(parseProblemUrl('https://www.codechef.com/users/tourist'), null);
  assert.equal(parseProblemUrl('https://www.codechef.com/submissions'), null);
  assert.equal(parseProblemUrl('https://www.codechef.com/'), null);
});

// ── isAcceptedVerdict tests ───────────────────────────────────────────────────

test('isAcceptedVerdict recognizes "Accepted" in various letter cases', async () => {
  const { isAcceptedVerdict } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.equal(isAcceptedVerdict('Accepted'), true);
  assert.equal(isAcceptedVerdict('accepted'), true);
  assert.equal(isAcceptedVerdict('ACCEPTED'), true);
  assert.equal(isAcceptedVerdict('  Accepted  '), true);
});

test('isAcceptedVerdict recognizes "Correct Answer"', async () => {
  const { isAcceptedVerdict } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.equal(isAcceptedVerdict('Correct Answer'), true);
  assert.equal(isAcceptedVerdict('correct answer'), true);
  assert.equal(isAcceptedVerdict('CORRECT ANSWER'), true);
  assert.equal(isAcceptedVerdict('  Correct Answer  '), true);
});

test('isAcceptedVerdict recognizes "100 pts" and score 100 variations', async () => {
  const { isAcceptedVerdict } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.equal(isAcceptedVerdict('100 pts'), true);
  assert.equal(isAcceptedVerdict('100 PTS'), true);
  assert.equal(isAcceptedVerdict('100pts'), true);
  assert.equal(isAcceptedVerdict('100 points'), true);
  assert.equal(isAcceptedVerdict('100'), true);
  assert.equal(isAcceptedVerdict('(100)'), true);
  assert.equal(isAcceptedVerdict('100.0 pts'), true);
});

test('isAcceptedVerdict recognizes "100/100"', async () => {
  const { isAcceptedVerdict } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.equal(isAcceptedVerdict('100/100'), true);
  assert.equal(isAcceptedVerdict('100 / 100'), true);
  assert.equal(isAcceptedVerdict('  100/100  '), true);
});

test('isAcceptedVerdict rejects non-accepted, partial, and error verdicts', async () => {
  const { isAcceptedVerdict } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.equal(isAcceptedVerdict('Wrong Answer'), false);
  assert.equal(isAcceptedVerdict('Time Limit Exceeded'), false);
  assert.equal(isAcceptedVerdict('Runtime Error (SIGSEGV)'), false);
  assert.equal(isAcceptedVerdict('Compilation Error'), false);
  assert.equal(isAcceptedVerdict('Partially Accepted'), false);
  assert.equal(isAcceptedVerdict('50 pts'), false);
  assert.equal(isAcceptedVerdict('50/100'), false);
  assert.equal(isAcceptedVerdict('0 pts'), false);
  assert.equal(isAcceptedVerdict('Pending'), false);
  assert.equal(isAcceptedVerdict(''), false);
  assert.equal(isAcceptedVerdict(null), false);
  assert.equal(isAcceptedVerdict(undefined), false);
});

// ── parseCodeChefDate tests ───────────────────────────────────────────────────

test('parseCodeChefDate converts IST "08:42 PM 16/09/26" to ISO 8601 UTC', async () => {
  const { parseCodeChefDate } = await importTypeScript('src/content/codechef-adapter.ts');

  // 8:42 PM IST on Sep 16, 2026 is 15:12 UTC
  const iso = parseCodeChefDate('08:42 PM 16/09/26');
  assert.equal(iso, '2026-09-16T15:12:00.000Z');
});

test('parseCodeChefDate converts morning IST "08:10 AM 02/09/2026" to UTC', async () => {
  const { parseCodeChefDate } = await importTypeScript('src/content/codechef-adapter.ts');

  // 8:10 AM IST on Sep 02, 2026 is 02:40 UTC
  const iso = parseCodeChefDate('08:10 AM 02/09/2026');
  assert.equal(iso, '2026-09-02T02:40:00.000Z');
});

test('parseCodeChefDate handles 12:00 AM (midnight) and 12:00 PM (noon)', async () => {
  const { parseCodeChefDate } = await importTypeScript('src/content/codechef-adapter.ts');

  // 12:00 AM IST on Jan 1, 2025 -> 18:30 UTC on Dec 31, 2024
  assert.equal(parseCodeChefDate('12:00 AM 01/01/25'), '2024-12-31T18:30:00.000Z');

  // 12:00 PM IST on Jan 1, 2025 -> 06:30 UTC on Jan 1, 2025
  assert.equal(parseCodeChefDate('12:00 PM 01/01/25'), '2025-01-01T06:30:00.000Z');
});

test('parseCodeChefDate falls back to current time for unrecognised input', async () => {
  const { parseCodeChefDate } = await importTypeScript('src/content/codechef-adapter.ts');

  const before = Date.now();
  const iso = parseCodeChefDate('invalid date string');
  const after = Date.now();
  const parsed = new Date(iso).getTime();
  assert.ok(parsed >= before && parsed <= after);
});

// ── normalizeLanguage tests ───────────────────────────────────────────────────

test('normalizeLanguage maps shorthand CodeChef language codes', async () => {
  const { normalizeLanguage } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.equal(normalizeLanguage('PYTH 3'), 'Python 3');
  assert.equal(normalizeLanguage('pyth 3'), 'Python 3');
  assert.equal(normalizeLanguage('PYTH'), 'Python');
  assert.equal(normalizeLanguage('pypy 3'), 'PyPy 3');
  assert.equal(normalizeLanguage('C++17'), 'C++17');
  assert.equal(normalizeLanguage('JAVA'), 'JAVA');
  assert.equal(normalizeLanguage('Rust'), 'Rust');
});

// ── extractLoggedInUsername tests ─────────────────────────────────────────────

test('extractLoggedInUsername reads username from input#user_handle', async () => {
  const { extractLoggedInUsername } = await importTypeScript('src/content/codechef-adapter.ts');

  const doc = parseHtml('<div><input type="hidden" id="user_handle" value="solid_coast_03" name="user_handle" /></div>');
  assert.equal(extractLoggedInUsername(doc), 'solid_coast_03');
});

test('extractLoggedInUsername reads username from .m-username--link', async () => {
  const { extractLoggedInUsername } = await importTypeScript('src/content/codechef-adapter.ts');

  const doc = parseHtml('<div><span class="m-username--link">solid_coast_03</span></div>');
  assert.equal(extractLoggedInUsername(doc), 'solid_coast_03');
});

test('extractLoggedInUsername reads username from header navigation link', async () => {
  const { extractLoggedInUsername } = await importTypeScript('src/content/codechef-adapter.ts');

  const doc = parseHtml('<div><nav><a href="/users/solid_coast_03">Profile</a></nav></div>');
  assert.equal(extractLoggedInUsername(doc), 'solid_coast_03');
});

test('extractLoggedInUsername reads username from window contexts', async () => {
  const { extractLoggedInUsername } = await importTypeScript('src/content/codechef-adapter.ts');

  const win1 = { codeChefUserData: { user: { username: 'solid_coast_03' } } };
  assert.equal(extractLoggedInUsername(null, win1), 'solid_coast_03');

  const win2 = { Drupal: { settings: { currentUser: 'solid_coast_03' } } };
  assert.equal(extractLoggedInUsername(null, win2), 'solid_coast_03');
});

test('extractLoggedInUsername returns null when no user indicators are present', async () => {
  const { extractLoggedInUsername } = await importTypeScript('src/content/codechef-adapter.ts');

  const doc = parseHtml('<div><p>Logged out</p></div>');
  assert.equal(extractLoggedInUsername(doc, {}), null);
});

// ── submissionIdFromRow tests ─────────────────────────────────────────────────

test('submissionIdFromRow extracts submission ID from /viewsolution/<id>', async () => {
  const { submissionIdFromRow } = await importTypeScript('src/content/codechef-adapter.ts');

  const row = parseHtml('<tr><td><a href="/viewsolution/1358040109" target="_blank">View</a></td></tr>');
  assert.equal(submissionIdFromRow(row), '1358040109');
});

test('submissionIdFromRow returns null when /viewsolution/ link is missing', async () => {
  const { submissionIdFromRow } = await importTypeScript('src/content/codechef-adapter.ts');

  const row = parseHtml('<tr><td>No submission link</td></tr>');
  assert.equal(submissionIdFromRow(row), null);
});

// ── Live Row Regression Tests: FIXEDPTS (Accepted) ────────────────────────────

const LIVE_FIXEDPTS_ROW_HTML = `<tr >
  <td  title='08:42 PM 16/09/26'>
    <span class='tooltips'>
      <i class='fa fa-clock-o'></i>
      <span class='tooltiptext'>08:42 PM 16/09/26</span>
    </span>
  </td>
  <td  title='FIXEDPTS'><a href='/START256D/problems/FIXEDPTS' title='' target='_blank'>FIXEDPTS</a></td>
  <td  title='(100)'><span title='accepted' style='display: flex;justify-content: center;align-items: center;width: 50px;flex-direction: column;'><img src='https://cdn.codechef.com/misc/tick-icon.gif'  alt='status icon'><span style='margin-top: 5px; font-size: 12px;white-space: nowrap;width: 100%;text-align: center;
  overflow: hidden;text-overflow: ellipsis;'>(100)</span><span style='margin-top: 5px; font-size: 12px; white-space: nowrap;'></span></span></td>
  <td  title='PYTH 3'>PYTH 3</td>
  <td class="centered" style="width:60px;" title='View'><a  class = 'centered' href='/viewsolution/1358040109' target='_blank'>View</a></td>
</tr>`;

test('isAcceptedRow identifies live FIXEDPTS row as accepted', async () => {
  const { isAcceptedRow } = await importTypeScript('src/content/codechef-adapter.ts');

  const row = parseHtml(LIVE_FIXEDPTS_ROW_HTML);
  assert.equal(isAcceptedRow(row), true);
});

test('extractLanguage identifies Python 3 from live FIXEDPTS row', async () => {
  const { extractLanguage } = await importTypeScript('src/content/codechef-adapter.ts');

  const row = parseHtml(LIVE_FIXEDPTS_ROW_HTML);
  assert.equal(extractLanguage(row), 'Python 3');
});

test('parseSubmissionRow parses the verified live FIXEDPTS row completely', async () => {
  const { parseSubmissionRow } = await importTypeScript('src/content/codechef-adapter.ts');

  const row = parseHtml(LIVE_FIXEDPTS_ROW_HTML);
  const data = parseSubmissionRow(row);

  assert.ok(data !== null, 'parseSubmissionRow should not return null for valid row');
  assert.equal(data.submissionId, '1358040109');
  assert.equal(data.submissionUrl, 'https://www.codechef.com/viewsolution/1358040109');
  assert.equal(data.contestId, 'START256D');
  assert.equal(data.problemId, 'FIXEDPTS');
  assert.equal(data.problemTitle, 'FIXEDPTS');
  assert.equal(data.problemUrl, 'https://www.codechef.com/START256D/problems/FIXEDPTS');
  assert.equal(data.language, 'Python 3');
  assert.equal(data.submittedAt, '2026-09-16T15:12:00.000Z');
  assert.equal(data.isAccepted, true);
});

// ── Live Row Regression Tests: BUSSEAT (Wrong Answer) ─────────────────────────

const LIVE_BUSSEAT_WA_ROW_HTML = `<tr >
  <td  title='08:23 PM 16/09/26'>
    <span class='tooltips'>
      <i class='fa fa-clock-o'></i>
      <span class='tooltiptext'>08:23 PM 16/09/26</span>
    </span>
  </td>
  <td  title='BUSSEAT'><a href='/START256D/problems/BUSSEAT' title='' target='_blank'>BUSSEAT</a></td>
  <td  title=''><span title='wrong answer' style='display: flex;justify-content: center;align-items: center;width: 50px;flex-direction: column;'><img src='https://cdn.codechef.com/misc/cross-icon.gif'  alt='status icon'><span style='margin-top: 5px; font-size: 12px;white-space: nowrap;width: 100%;text-align: center;
  overflow: hidden;text-overflow: ellipsis;'></span><span style='margin-top: 5px; font-size: 12px; white-space: nowrap;'></span></span></td>
  <td  title='PYTH 3'>PYTH 3</td>
  <td class="centered" style="width:60px;" title='View'><a  class = 'centered' href='/viewsolution/1358003340' target='_blank'>View</a></td>
</tr>`;

test('isAcceptedRow identifies live BUSSEAT WA row as not accepted', async () => {
  const { isAcceptedRow } = await importTypeScript('src/content/codechef-adapter.ts');

  const row = parseHtml(LIVE_BUSSEAT_WA_ROW_HTML);
  assert.equal(isAcceptedRow(row), false);
});

test('parseSubmissionRow parses live BUSSEAT WA row with isAccepted=false', async () => {
  const { parseSubmissionRow } = await importTypeScript('src/content/codechef-adapter.ts');

  const row = parseHtml(LIVE_BUSSEAT_WA_ROW_HTML);
  const data = parseSubmissionRow(row);

  assert.ok(data !== null);
  assert.equal(data.submissionId, '1358003340');
  assert.equal(data.contestId, 'START256D');
  assert.equal(data.problemId, 'BUSSEAT');
  assert.equal(data.isAccepted, false);
});

test('parseSubmissionRow returns null for table headers or invalid rows', async () => {
  const { parseSubmissionRow } = await importTypeScript('src/content/codechef-adapter.ts');

  const headerRow = parseHtml('<tr><th>Time</th><th>Problem</th><th>Result</th><th>Lang</th><th>Solution</th></tr>');
  assert.equal(parseSubmissionRow(headerRow), null);
});

// ── Submission Source Retrieval Tests ─────────────────────────────────────────

const LIVE_SUBMISSION_JSON = {
  status: 'success',
  message: 'successfully fetched submission',
  data: {
    code: '# cook your dish here\r\nt=int(input())\r\nfor _ in range(t):\r\n    N,K=map(int,input().split())\r\n    if K==N-1:\r\n        print(-1)\r\n    else:\r\n        print(*range(1,K+1),*range(K+2,N+1),K+1)\r\n',
    language: {
      short_name: 'PYTH 3',
      id: '116',
      extension: 'py',
      full_name: 'Python3',
    },
  },
};

test('parseSubmissionSourceResponse parses verified live JSON response', async () => {
  const { parseSubmissionSourceResponse } = await importTypeScript('src/content/codechef-adapter.ts');

  const result = parseSubmissionSourceResponse(LIVE_SUBMISSION_JSON);
  assert.ok(result !== null);
  assert.equal(result.code, LIVE_SUBMISSION_JSON.data.code);
  assert.deepEqual(result.language, {
    shortName: 'PYTH 3',
    fullName: 'Python3',
    extension: 'py',
    id: '116',
  });
});

test('parseSubmissionSourceResponse parses raw JSON string payload', async () => {
  const { parseSubmissionSourceResponse } = await importTypeScript('src/content/codechef-adapter.ts');

  const str = JSON.stringify(LIVE_SUBMISSION_JSON);
  const result = parseSubmissionSourceResponse(str);
  assert.ok(result !== null);
  assert.equal(result.code, LIVE_SUBMISSION_JSON.data.code);
  assert.equal(result.language.extension, 'py');
});

test('parseSubmissionSourceResponse returns null for error status payloads', async () => {
  const { parseSubmissionSourceResponse } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.equal(parseSubmissionSourceResponse({ status: 'error', message: 'Submission Not Found' }), null);
  assert.equal(parseSubmissionSourceResponse({ status: 'error', message: 'Invalid Submission Id' }), null);
});

test('parseSubmissionSourceResponse returns null for missing or empty code', async () => {
  const { parseSubmissionSourceResponse } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.equal(parseSubmissionSourceResponse({
    status: 'success',
    data: { code: '', language: { short_name: 'CPP', extension: 'cpp', full_name: 'C++' } },
  }), null);

  assert.equal(parseSubmissionSourceResponse({
    status: 'success',
    data: { language: { short_name: 'CPP' } },
  }), null);
});

test('parseSubmissionSourceResponse returns null for malformed JSON or empty input', async () => {
  const { parseSubmissionSourceResponse } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.equal(parseSubmissionSourceResponse('invalid json {'), null);
  assert.equal(parseSubmissionSourceResponse(''), null);
  assert.equal(parseSubmissionSourceResponse(null), null);
  assert.equal(parseSubmissionSourceResponse(undefined), null);
});

test('fetchSubmissionSource succeeds with 200 response and verified payload', async () => {
  const { fetchSubmissionSource } = await importTypeScript('src/content/codechef-adapter.ts');

  let calledUrl = '';
  const mockFetch = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(LIVE_SUBMISSION_JSON),
    };
  };

  const result = await fetchSubmissionSource('1358040109', { fetchFn: mockFetch });
  assert.ok(result !== null);
  assert.equal(calledUrl, 'https://www.codechef.com/api/submission-code/1358040109');
  assert.equal(result.code, LIVE_SUBMISSION_JSON.data.code);
  assert.equal(result.language.shortName, 'PYTH 3');
  assert.equal(result.language.extension, 'py');
});

test('fetchSubmissionSource supports custom origin', async () => {
  const { fetchSubmissionSource } = await importTypeScript('src/content/codechef-adapter.ts');

  let calledUrl = '';
  const mockFetch = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(LIVE_SUBMISSION_JSON),
    };
  };

  await fetchSubmissionSource('1358040109', {
    origin: 'https://custom.codechef.com',
    fetchFn: mockFetch,
  });
  assert.equal(calledUrl, 'https://custom.codechef.com/api/submission-code/1358040109');
});

test('fetchSubmissionSource returns null on non-200 HTTP responses', async () => {
  const { fetchSubmissionSource } = await importTypeScript('src/content/codechef-adapter.ts');

  const mock404 = async () => ({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({ status: 'error', message: 'Submission Not Found' }),
  });

  const res404 = await fetchSubmissionSource('999999999999', { fetchFn: mock404 });
  assert.equal(res404, null);

  const mock500 = async () => ({
    ok: false,
    status: 500,
    text: async () => 'Internal Server Error',
  });

  const res500 = await fetchSubmissionSource('1358040109', { fetchFn: mock500 });
  assert.equal(res500, null);
});

test('fetchSubmissionSource returns null when network fetch throws', async () => {
  const { fetchSubmissionSource } = await importTypeScript('src/content/codechef-adapter.ts');

  const throwingFetch = async () => {
    throw new Error('Network error');
  };

  const result = await fetchSubmissionSource('1358040109', { fetchFn: throwingFetch });
  assert.equal(result, null);
});

test('fetchSubmissionSource returns null for invalid or non-numeric submission IDs without calling fetch', async () => {
  const { fetchSubmissionSource } = await importTypeScript('src/content/codechef-adapter.ts');

  let called = false;
  const mockFetch = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => '{}' };
  };

  assert.equal(await fetchSubmissionSource('', { fetchFn: mockFetch }), null);
  assert.equal(await fetchSubmissionSource('abc', { fetchFn: mockFetch }), null);
  assert.equal(await fetchSubmissionSource('123abc', { fetchFn: mockFetch }), null);
  assert.equal(called, false);
});

// ── Profile Page & Username Path Recognition Tests ────────────────────────────

test('isProfilePage recognizes valid CodeChef user profile path patterns', async () => {
  const { isProfilePage } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.equal(isProfilePage('/users/solid_coast_03'), true);
  assert.equal(isProfilePage('/users/solid_coast_03/'), true);
  assert.equal(isProfilePage('/users/tourist?tab=recent'), true);
  assert.equal(isProfilePage('/users/tourist#activity'), true);

  assert.equal(isProfilePage('/'), false);
  assert.equal(isProfilePage('/problems/FLOW001'), false);
  assert.equal(isProfilePage('/START256D'), false);
  assert.equal(isProfilePage('/status'), false);
  assert.equal(isProfilePage(''), false);
});

test('profileUsernameFromPath extracts username from profile paths', async () => {
  const { profileUsernameFromPath } = await importTypeScript('src/content/codechef-adapter.ts');

  assert.equal(profileUsernameFromPath('/users/solid_coast_03'), 'solid_coast_03');
  assert.equal(profileUsernameFromPath('/users/solid_coast_03/'), 'solid_coast_03');
  assert.equal(profileUsernameFromPath('/users/tourist?tab=recent'), 'tourist');
  assert.equal(profileUsernameFromPath('/problems/FLOW001'), null);
});

test('isLoggedInUserProfile validates that current page belongs to logged-in user', async () => {
  const { isLoggedInUserProfile } = await importTypeScript('src/content/codechef-adapter.ts');

  const winSelf = { codeChefUserData: { user: { username: 'solid_coast_03' } } };
  assert.equal(isLoggedInUserProfile('/users/solid_coast_03', null, winSelf), true);
  assert.equal(isLoggedInUserProfile('/users/SOLID_COAST_03', null, winSelf), true);

  // Visiting someone else's profile should return false
  assert.equal(isLoggedInUserProfile('/users/tourist', null, winSelf), false);

  // Non-profile page should return false
  assert.equal(isLoggedInUserProfile('/problems/FIXEDPTS', null, winSelf), false);
});

// ── submissionFromRowData Tests ───────────────────────────────────────────────

test('submissionFromRowData builds a durable Submission for GitHub sync queue', async () => {
  const { submissionFromRowData } = await importTypeScript('src/content/codechef-adapter.ts');

  const rowData = {
    submissionId: '1358040109',
    submissionUrl: 'https://www.codechef.com/viewsolution/1358040109',
    contestId: 'START256D',
    problemId: 'FIXEDPTS',
    problemTitle: 'FIXEDPTS',
    problemUrl: 'https://www.codechef.com/START256D/problems/FIXEDPTS',
    language: 'Python 3',
    submittedAt: '2026-09-16T15:12:00.000Z',
    isAccepted: true,
  };

  const dummyCode = 'print("Hello World")';
  const sub = submissionFromRowData(rowData, dummyCode);

  assert.deepEqual(sub, {
    platform: 'codechef',
    submissionId: '1358040109',
    problemId: 'FIXEDPTS',
    problemTitle: 'FIXEDPTS',
    language: 'Python 3',
    sourceCode: dummyCode,
    verdict: 'accepted',
    submittedAt: '2026-09-16T15:12:00.000Z',
    problemUrl: 'https://www.codechef.com/START256D/problems/FIXEDPTS',
    contest: 'START256D',
  });
});

test('submissionFromRowData defaults contest to Practice when contestId is Practice', async () => {
  const { submissionFromRowData } = await importTypeScript('src/content/codechef-adapter.ts');

  const rowData = {
    submissionId: '12345678',
    submissionUrl: 'https://www.codechef.com/viewsolution/12345678',
    contestId: 'Practice',
    problemId: 'FLOW001',
    problemTitle: 'Add Two Numbers',
    problemUrl: 'https://www.codechef.com/problems/FLOW001',
    language: 'Python 3',
    submittedAt: '2026-09-16T15:12:00.000Z',
    isAccepted: true,
  };

  const sub = submissionFromRowData(rowData, 'a = 1');
  assert.equal(sub.contest, 'Practice');
  assert.equal(sub.platform, 'codechef');
});


