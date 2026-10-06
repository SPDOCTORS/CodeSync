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

const {
  parseSubmissionUrl,
  parseTaskUrl,
  isAcceptedVerdict,
  normalizeLanguage,
  extractSourceCode,
  parseSubmissionTimestamp,
  extractUsername,
  parseSubmissionPage,
  isSubmissionResultPage,
  submissionFromPageData,
  processSubmissionPage,
} = await importTypeScript('src/content/atcoder-adapter.ts');

test('parseSubmissionUrl extracts contestId and submissionId from valid AtCoder URLs and paths', () => {
  assert.deepEqual(
    parseSubmissionUrl('https://atcoder.jp/contests/abc375/submissions/58392104'),
    { contestId: 'abc375', submissionId: '58392104' },
  );

  assert.deepEqual(
    parseSubmissionUrl('https://atcoder.jp/contests/abc375/submissions/58392104/'),
    { contestId: 'abc375', submissionId: '58392104' },
  );

  assert.deepEqual(
    parseSubmissionUrl('/contests/arc180/submissions/1234567'),
    { contestId: 'arc180', submissionId: '1234567' },
  );

  assert.deepEqual(
    parseSubmissionUrl('https://atcoder.jp/contests/typical90/submissions/9999999?f.User=tourist#code'),
    { contestId: 'typical90', submissionId: '9999999' },
  );

  assert.equal(parseSubmissionUrl(null), null);
  assert.equal(parseSubmissionUrl(''), null);
  assert.equal(parseSubmissionUrl('https://atcoder.jp/contests/abc375/tasks/abc375_a'), null);
  assert.equal(parseSubmissionUrl('https://atcoder.jp/contests/abc375/submissions'), null);
});

test('parseTaskUrl extracts contestId and taskId from valid AtCoder URLs and paths', () => {
  assert.deepEqual(
    parseTaskUrl('https://atcoder.jp/contests/abc375/tasks/abc375_a'),
    { contestId: 'abc375', taskId: 'abc375_a' },
  );

  assert.deepEqual(
    parseTaskUrl('https://atcoder.jp/contests/abc375/tasks/abc375_a/'),
    { contestId: 'abc375', taskId: 'abc375_a' },
  );

  assert.deepEqual(
    parseTaskUrl('/contests/practice/tasks/practice_1'),
    { contestId: 'practice', taskId: 'practice_1' },
  );

  assert.equal(parseTaskUrl(null), null);
  assert.equal(parseTaskUrl(''), null);
  assert.equal(parseTaskUrl('https://atcoder.jp/contests/abc375/submissions/58392104'), null);
});

test('isAcceptedVerdict detects AC verdict and label-success while rejecting non-AC statuses', () => {
  // AC variations
  assert.equal(isAcceptedVerdict('AC'), true);
  assert.equal(isAcceptedVerdict('ac'), true);
  assert.equal(isAcceptedVerdict(' AC '), true);
  assert.equal(isAcceptedVerdict('AC', 'label label-success'), true);
  assert.equal(isAcceptedVerdict('', 'label label-success'), true);
  assert.equal(isAcceptedVerdict(null, 'badge badge-success'), true);

  // Non-AC verdicts
  assert.equal(isAcceptedVerdict('WA'), false);
  assert.equal(isAcceptedVerdict('TLE'), false);
  assert.equal(isAcceptedVerdict('MLE'), false);
  assert.equal(isAcceptedVerdict('RE'), false);
  assert.equal(isAcceptedVerdict('CE'), false);
  assert.equal(isAcceptedVerdict('QLE'), false);
  assert.equal(isAcceptedVerdict('WJ'), false);
  assert.equal(isAcceptedVerdict('WR'), false);
  assert.equal(isAcceptedVerdict('Judging'), false);
  assert.equal(isAcceptedVerdict('15/30'), false);
  assert.equal(isAcceptedVerdict('[0/30]'), false);
  assert.equal(isAcceptedVerdict('WA', 'label label-warning'), false);
  assert.equal(isAcceptedVerdict(null, null), false);
  assert.equal(isAcceptedVerdict('', ''), false);
});

test('normalizeLanguage maps compiler strings to canonical language names and extensions', () => {
  assert.deepEqual(normalizeLanguage('C++ 20 (gcc 12.2)'), { name: 'C++ 20', extension: 'cpp' });
  assert.deepEqual(normalizeLanguage('C++ 23 (gcc 12.2)'), { name: 'C++ 23', extension: 'cpp' });
  assert.deepEqual(normalizeLanguage('C++ (GCC 9.2.1)'), { name: 'C++', extension: 'cpp' });
  assert.deepEqual(normalizeLanguage('Python (CPython 3.11.4)'), { name: 'Python', extension: 'py' });
  assert.deepEqual(normalizeLanguage('Python (PyPy 3.10-v7.3.12)'), { name: 'Python', extension: 'py' });
  assert.deepEqual(normalizeLanguage('Java (OpenJDK 17)'), { name: 'Java', extension: 'java' });
  assert.deepEqual(normalizeLanguage('Rust (rustc 1.70.0)'), { name: 'Rust', extension: 'rs' });
  assert.deepEqual(normalizeLanguage('Go (go 1.20.6)'), { name: 'Go', extension: 'go' });
  assert.deepEqual(normalizeLanguage('C# 11.0 (.NET 7.0.7)'), { name: 'C#', extension: 'cs' });
  assert.deepEqual(normalizeLanguage('TypeScript (Node.js 18.16.1)'), { name: 'TypeScript', extension: 'ts' });
  assert.deepEqual(normalizeLanguage('JavaScript (Node.js 18.16.1)'), { name: 'JavaScript', extension: 'js' });
  assert.deepEqual(normalizeLanguage('C (GCC 12.2.0)'), { name: 'C', extension: 'c' });
  assert.deepEqual(normalizeLanguage('Kotlin (Kotlin/JVM 1.8.20)'), { name: 'Kotlin', extension: 'kt' });
  assert.deepEqual(normalizeLanguage(null), { name: 'Unknown', extension: 'txt' });
  assert.deepEqual(normalizeLanguage(''), { name: 'Unknown', extension: 'txt' });
});

test('extractSourceCode extracts code and decodes HTML entities from DOM nodes and strings', () => {
  // DOM element simulation
  const mockNode = {
    textContent: '#include <iostream>\nusing namespace std;\nint main() { cout << "Hello & World" << endl; return 0; }',
  };
  assert.equal(
    extractSourceCode(mockNode),
    '#include <iostream>\nusing namespace std;\nint main() { cout << "Hello & World" << endl; return 0; }',
  );

  // Container element with #submission-code inside
  const container = {
    querySelector(sel) {
      if (sel.includes('#submission-code')) {
        return { textContent: 'print(&quot;Hello&quot; &amp;&amp; 42 &gt; 10)' };
      }
      return null;
    },
  };
  assert.equal(extractSourceCode(container), 'print("Hello" && 42 > 10)');

  // Raw HTML string
  const rawHtml = '<pre id="submission-code" class="prettyprint linenums">a, b = map(int, input().split())&#10;print(a + b)</pre>';
  assert.equal(extractSourceCode(rawHtml), 'a, b = map(int, input().split())&#10;print(a + b)');

  // Null / empty
  assert.equal(extractSourceCode(null), '');
  assert.equal(extractSourceCode(''), '');
});

test('parseSubmissionTimestamp safely handles JST timestamps and ISO strings', () => {
  // Typical AtCoder timestamp with JST offset
  const tsWithOffset = parseSubmissionTimestamp('2024-10-05 21:05:32+0900');
  assert.ok(tsWithOffset != null);
  assert.equal(typeof tsWithOffset, 'number');

  // Without explicit offset (defaults to JST)
  const tsWithoutOffset = parseSubmissionTimestamp('2024-10-05 21:05:32');
  assert.ok(tsWithoutOffset != null);
  assert.equal(tsWithoutOffset, tsWithOffset);

  // Inside <time> element
  const timeTag = '<time class="fixtime fixtime-full">2024-10-05 21:05:32+0900</time>';
  assert.equal(parseSubmissionTimestamp(timeTag), tsWithOffset);

  // Invalid / null
  assert.equal(parseSubmissionTimestamp(null), null);
  assert.equal(parseSubmissionTimestamp(''), null);
  assert.equal(parseSubmissionTimestamp('not-a-date'), null);
});

// ── Lightweight DOM stub for testing parseSubmissionPage ──────────────

class MockElement {
  constructor(tagName, attributes = {}, textContent = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.children = [];
    this._textContent = textContent;
  }

  get textContent() {
    let t = this._textContent;
    for (const c of this.children) {
      t += c.textContent;
    }
    return t;
  }

  set textContent(v) {
    this._textContent = v;
  }

  getAttribute(name) {
    return this.attributes[name.toLowerCase()] ?? null;
  }

  get href() {
    return this.attributes['href'] ?? '';
  }

  get className() {
    return this.attributes['class'] ?? '';
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  querySelector(sel) {
    const list = this.querySelectorAll(sel);
    return list[0] ?? null;
  }

  querySelectorAll(sel) {
    const commaParts = sel.split(',').map(s => s.trim());
    const matchSimple = (elem, s) => {
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
      const attrPrefixMatch = s.match(/\[([a-zA-Z0-9_:-]+)\^=([\"']?)(.*?)\2\]/);
      if (attrPrefixMatch) {
        const attrVal = elem.attributes[attrPrefixMatch[1].toLowerCase()] ?? '';
        if (!attrVal.startsWith(attrPrefixMatch[3])) return false;
      }
      const attrSubMatch = s.match(/\[([a-zA-Z0-9_:-]+)\*=([\"']?)(.*?)\2\]/);
      if (attrSubMatch) {
        const attrVal = elem.attributes[attrSubMatch[1].toLowerCase()] ?? '';
        if (!attrVal.includes(attrSubMatch[3])) return false;
      }
      return true;
    };

    const results = [];
    const findDescendants = (node, tokens) => {
      if (tokens.length === 0) return;
      const [current, ...rest] = tokens;
      for (const child of node.children) {
        if (matchSimple(child, current)) {
          if (rest.length === 0) {
            if (!results.includes(child)) results.push(child);
          } else {
            findDescendants(child, rest);
          }
        }
        findDescendants(child, tokens);
      }
    };

    for (const part of commaParts) {
      const tokens = part.split(/\s+/).filter(Boolean);
      findDescendants(this, tokens);
    }
    return results;
  }
}

function createMockPage({
  contestId = 'abc375',
  submissionId = '58392104',
  taskId = 'abc375_a',
  problemTitle = 'A - Seats',
  author = 'tourist',
  loggedInUser = 'tourist',
  verdict = 'AC',
  badgeClass = 'label label-success',
  score = '100',
  language = 'C++ 20 (gcc 12.2)',
  submissionDate = '2024-10-05 21:05:32+0900',
  sourceCode = '#include <iostream>\nint main() { return 0; }',
} = {}) {
  const root = new MockElement('div');

  // Header / navbar with logged in user
  const header = new MockElement('header', { id: 'header' });
  if (loggedInUser) {
    const userLink = new MockElement('a', { href: `/users/${loggedInUser}`, class: 'username' }, loggedInUser);
    header.appendChild(userLink);
  } else {
    const loginLink = new MockElement('a', { href: '/login' }, 'Sign In');
    header.appendChild(loginLink);
  }
  root.appendChild(header);

  // Summary Table
  const table = new MockElement('table', { class: 'table table-bordered' });

  // Submission Date row
  const rowDate = new MockElement('tr');
  rowDate.appendChild(new MockElement('th', {}, 'Submission Date'));
  const tdDate = new MockElement('td');
  tdDate.appendChild(new MockElement('time', { class: 'fixtime' }, submissionDate));
  rowDate.appendChild(tdDate);
  table.appendChild(rowDate);

  // Task row
  const rowTask = new MockElement('tr');
  rowTask.appendChild(new MockElement('th', {}, 'Task'));
  const tdTask = new MockElement('td');
  tdTask.appendChild(new MockElement('a', { href: `/contests/${contestId}/tasks/${taskId}` }, problemTitle));
  rowTask.appendChild(tdTask);
  table.appendChild(rowTask);

  // User row
  const rowUser = new MockElement('tr');
  rowUser.appendChild(new MockElement('th', {}, 'User'));
  const tdUser = new MockElement('td');
  tdUser.appendChild(new MockElement('a', { href: `/users/${author}` }, author));
  rowUser.appendChild(tdUser);
  table.appendChild(rowUser);

  // Language row
  const rowLang = new MockElement('tr');
  rowLang.appendChild(new MockElement('th', {}, 'Language'));
  rowLang.appendChild(new MockElement('td', {}, language));
  table.appendChild(rowLang);

  // Score row
  const rowScore = new MockElement('tr');
  rowScore.appendChild(new MockElement('th', {}, 'Score'));
  rowScore.appendChild(new MockElement('td', {}, score));
  table.appendChild(rowScore);

  // Status / Verdict row
  const rowStatus = new MockElement('tr');
  rowStatus.appendChild(new MockElement('th', {}, 'Status'));
  const tdStatus = new MockElement('td');
  tdStatus.appendChild(new MockElement('span', { class: badgeClass }, verdict));
  rowStatus.appendChild(tdStatus);
  table.appendChild(rowStatus);

  root.appendChild(table);

  // Source code pre
  const codePre = new MockElement('pre', { id: 'submission-code', class: 'prettyprint' }, sourceCode);
  root.appendChild(codePre);

  return {
    root,
    url: `https://atcoder.jp/contests/${contestId}/submissions/${submissionId}`,
  };
}

test('parseSubmissionPage correctly extracts AC submission owned by logged-in user', () => {
  const { root, url } = createMockPage({
    contestId: 'abc375',
    submissionId: '58392104',
    taskId: 'abc375_a',
    problemTitle: 'A - Seats',
    author: 'my_handle',
    loggedInUser: 'my_handle',
    verdict: 'AC',
    badgeClass: 'label label-success',
    score: '100',
    language: 'C++ 20 (gcc 12.2)',
    sourceCode: '#include <bits/stdc++.h>\nusing namespace std;\nint main() {}',
  });

  const parsed = parseSubmissionPage(root, { url });
  assert.ok(parsed != null);
  assert.equal(parsed.submissionId, '58392104');
  assert.equal(parsed.contestId, 'abc375');
  assert.equal(parsed.taskId, 'abc375_a');
  assert.equal(parsed.problemTitle, 'A - Seats');
  assert.equal(parsed.author, 'my_handle');
  assert.equal(parsed.username, 'my_handle');
  assert.equal(parsed.isOwner, true);
  assert.equal(parsed.isAccepted, true);
  assert.equal(parsed.verdict, 'AC');
  assert.equal(parsed.score, '100');
  assert.equal(parsed.language, 'C++ 20');
  assert.ok(parsed.timestamp != null);
  assert.equal(parsed.code, '#include <bits/stdc++.h>\nusing namespace std;\nint main() {}');
});

test('parseSubmissionPage handles AC submission by another user (isAccepted=true, isOwner=false)', () => {
  const { root, url } = createMockPage({
    author: 'tourist',
    loggedInUser: 'my_handle',
    verdict: 'AC',
    badgeClass: 'label label-success',
  });

  const parsed = parseSubmissionPage(root, { url });
  assert.ok(parsed != null);
  assert.equal(parsed.author, 'tourist');
  assert.equal(parsed.username, 'my_handle');
  assert.equal(parsed.isOwner, false);
  assert.equal(parsed.isAccepted, true);
});

test('parseSubmissionPage handles Wrong Answer (WA) submission (isAccepted=false)', () => {
  const { root, url } = createMockPage({
    author: 'my_handle',
    loggedInUser: 'my_handle',
    verdict: 'WA',
    badgeClass: 'label label-warning',
    score: '0',
  });

  const parsed = parseSubmissionPage(root, { url });
  assert.ok(parsed != null);
  assert.equal(parsed.isOwner, true);
  assert.equal(parsed.isAccepted, false);
  assert.equal(parsed.verdict, 'WA');
  assert.equal(parsed.score, '0');
});

test('parseSubmissionPage handles in-progress Waiting for Judging (WJ) submission', () => {
  const { root, url } = createMockPage({
    verdict: 'WJ',
    badgeClass: 'label label-default',
  });

  const parsed = parseSubmissionPage(root, { url });
  assert.ok(parsed != null);
  assert.equal(parsed.isAccepted, false);
  assert.equal(parsed.verdict, 'WJ');
});

test('parseSubmissionPage handles malformed or incomplete pages gracefully', () => {
  // Empty root
  assert.equal(parseSubmissionPage(null), null);

  // Empty element with no links or tables
  const emptyRoot = new MockElement('div');
  assert.equal(parseSubmissionPage(emptyRoot), null);

  // Missing task link
  const noTaskRoot = new MockElement('div');
  const emptyTable = new MockElement('table', { class: 'table' });
  noTaskRoot.appendChild(emptyTable);
  assert.equal(
    parseSubmissionPage(noTaskRoot, { url: 'https://atcoder.jp/contests/abc375/submissions/12345' }),
    null,
  );
});

test('isSubmissionResultPage correctly identifies AtCoder submission result paths', () => {
  assert.equal(isSubmissionResultPage('/contests/abc375/submissions/58392104'), true);
  assert.equal(isSubmissionResultPage('/contests/abc375/submissions/58392104/'), true);
  assert.equal(isSubmissionResultPage('/contests/practice/submissions/1'), true);

  assert.equal(isSubmissionResultPage('/contests/abc375/tasks/abc375_a'), false);
  assert.equal(isSubmissionResultPage('/contests/abc375/submissions'), false);
  assert.equal(isSubmissionResultPage('/contests/abc375/submissions/me'), false);
  assert.equal(isSubmissionResultPage(null), false);
  assert.equal(isSubmissionResultPage(''), false);
});

test('submissionFromPageData creates valid normalized Submission payload', () => {
  const mockData = {
    submissionId: '58392104',
    contestId: 'abc375',
    taskId: 'abc375_a',
    problemTitle: 'A - Seats',
    author: 'my_handle',
    username: 'my_handle',
    isOwner: true,
    verdict: 'AC',
    isAccepted: true,
    score: '100',
    language: 'C++ 20',
    submittedAt: '2024-10-05 21:05:32+0900',
    timestamp: 1728129932000,
    code: 'int main() {}',
  };

  const submission = submissionFromPageData(mockData, 'https://atcoder.jp');
  assert.equal(submission.platform, 'atcoder');
  assert.equal(submission.submissionId, '58392104');
  assert.equal(submission.problemId, 'abc375_a');
  assert.equal(submission.problemTitle, 'A - Seats');
  assert.equal(submission.contest, 'abc375');
  assert.equal(submission.language, 'C++ 20');
  assert.equal(submission.sourceCode, 'int main() {}');
  assert.equal(submission.verdict, 'accepted');
  assert.equal(submission.problemUrl, 'https://atcoder.jp/contests/abc375/tasks/abc375_a');
});

test('processSubmissionPage queues accepted owner submission and prevents duplicates', async () => {
  const { root, url } = createMockPage({
    contestId: 'abc375',
    submissionId: '58392104',
    author: 'my_handle',
    loggedInUser: 'my_handle',
    verdict: 'AC',
  });

  const observed = new Set();
  const queuedItems = [];
  const queueFn = async s => {
    queuedItems.push(s);
    return { queued: true };
  };

  const outcome = await processSubmissionPage(root, { url, observed, queueFn });
  assert.equal(outcome.status, 'queued');
  assert.equal(queuedItems.length, 1);
  assert.equal(queuedItems[0].submissionId, '58392104');
  assert.ok(observed.has('atcoder:58392104'));

  // Immediate retry should be caught as duplicate
  const outcome2 = await processSubmissionPage(root, { url, observed, queueFn });
  assert.equal(outcome2.status, 'duplicate');
  assert.equal(queuedItems.length, 1);
});

test('processSubmissionPage does not queue when isOwner is false', async () => {
  const { root, url } = createMockPage({
    submissionId: '11111111',
    author: 'tourist',
    loggedInUser: 'my_handle',
    verdict: 'AC',
  });

  const observed = new Set();
  const queuedItems = [];
  const queueFn = async s => {
    queuedItems.push(s);
    return { queued: true };
  };

  const outcome = await processSubmissionPage(root, { url, observed, queueFn });
  assert.equal(outcome.status, 'not_owner');
  assert.equal(queuedItems.length, 0);
  assert.ok(observed.has('atcoder:11111111'));
});

test('processSubmissionPage does not queue when verdict is not AC (e.g. WA)', async () => {
  const { root, url } = createMockPage({
    submissionId: '22222222',
    author: 'my_handle',
    loggedInUser: 'my_handle',
    verdict: 'WA',
    badgeClass: 'label label-warning',
  });

  const observed = new Set();
  const queuedItems = [];
  const queueFn = async s => {
    queuedItems.push(s);
    return { queued: true };
  };

  const outcome = await processSubmissionPage(root, { url, observed, queueFn });
  assert.equal(outcome.status, 'rejected');
  assert.equal(queuedItems.length, 0);
  assert.ok(observed.has('atcoder:22222222'));
});

test('processSubmissionPage leaves observed unflagged during in-progress judging (WJ)', async () => {
  const { root, url } = createMockPage({
    submissionId: '33333333',
    author: 'my_handle',
    loggedInUser: 'my_handle',
    verdict: 'WJ',
  });

  const observed = new Set();
  const queuedItems = [];
  const queueFn = async s => {
    queuedItems.push(s);
    return { queued: true };
  };

  const outcome = await processSubmissionPage(root, { url, observed, queueFn });
  assert.equal(outcome.status, 'pending');
  assert.equal(queuedItems.length, 0);
  // observed must NOT have this submissionId so the subsequent mutation can re-evaluate
  assert.ok(!observed.has('atcoder:33333333'));
});


