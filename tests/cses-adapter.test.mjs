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

// ── Lightweight DOM stub for tests without browser environment ──────────────

class SimpleElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.children = [];
    this._textContent = '';
    this.dataset = {};
    this.previousElementSibling = null;
    this.nextElementSibling = null;
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

function parseHtml(html) {
  const tagRe =
    /<\/?([a-zA-Z0-9-]+)((?:\s+[a-zA-Z0-9_:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
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

  function wireSiblings(parent) {
    for (let i = 0; i < parent.children.length; i++) {
      parent.children[i].previousElementSibling = i > 0 ? parent.children[i - 1] : null;
      parent.children[i].nextElementSibling =
        i < parent.children.length - 1 ? parent.children[i + 1] : null;
      wireSiblings(parent.children[i]);
    }
  }
  wireSiblings(root);

  return root.children.length === 1 ? root.children[0] : root;
}

// ── Unit Tests: Foundation ──────────────────────────────────────────────────

test('parseResultUrl extracts submission IDs from various CSES URL patterns', async () => {
  const { parseResultUrl } = await importTypeScript('src/content/cses-adapter.ts');

  assert.deepEqual(parseResultUrl('https://cses.fi/problemset/result/3889109/'), {
    submissionId: '3889109',
  });
  assert.deepEqual(parseResultUrl('https://cses.fi/problemset/result/3889109'), {
    submissionId: '3889109',
  });
  assert.deepEqual(parseResultUrl('http://cses.fi/problemset/result/12345/'), {
    submissionId: '12345',
  });
  assert.deepEqual(parseResultUrl('/problemset/result/102030/'), {
    submissionId: '102030',
  });
  assert.deepEqual(parseResultUrl('/problemset/result/102030'), {
    submissionId: '102030',
  });
  assert.deepEqual(parseResultUrl('/course/result/5555/'), {
    submissionId: '5555',
  });
  assert.deepEqual(parseResultUrl('https://cses.fi/problemset/result/999?tab=tests#top'), {
    submissionId: '999',
  });

  // Invalid / non-result URLs
  assert.equal(parseResultUrl('https://cses.fi/problemset/task/1068/'), null);
  assert.equal(parseResultUrl('https://cses.fi/login'), null);
  assert.equal(parseResultUrl('https://cses.fi/problemset/list'), null);
  assert.equal(parseResultUrl(''), null);
  assert.equal(parseResultUrl(null), null);
  assert.equal(parseResultUrl(undefined), null);
});

test('parseTaskUrl extracts problem IDs from various CSES URL patterns', async () => {
  const { parseTaskUrl } = await importTypeScript('src/content/cses-adapter.ts');

  assert.deepEqual(parseTaskUrl('https://cses.fi/problemset/task/1068/'), {
    problemId: '1068',
  });
  assert.deepEqual(parseTaskUrl('https://cses.fi/problemset/task/1068'), {
    problemId: '1068',
  });
  assert.deepEqual(parseTaskUrl('http://cses.fi/problemset/task/1083/'), {
    problemId: '1083',
  });
  assert.deepEqual(parseTaskUrl('/problemset/task/1621/'), {
    problemId: '1621',
  });
  assert.deepEqual(parseTaskUrl('/problemset/task/1621'), {
    problemId: '1621',
  });
  assert.deepEqual(parseTaskUrl('/course/task/2165/'), {
    problemId: '2165',
  });
  assert.deepEqual(parseTaskUrl('https://cses.fi/problemset/task/1068?view=all#example'), {
    problemId: '1068',
  });

  // Invalid / non-task URLs
  assert.equal(parseTaskUrl('https://cses.fi/problemset/result/3889109/'), null);
  assert.equal(parseTaskUrl('https://cses.fi/login'), null);
  assert.equal(parseTaskUrl('https://cses.fi/'), null);
  assert.equal(parseTaskUrl(''), null);
  assert.equal(parseTaskUrl(null), null);
  assert.equal(parseTaskUrl(undefined), null);
});

test('isAcceptedVerdict detects Accepted verdicts and 100% scores correctly; READY alone is NOT accepted', async () => {
  const { isAcceptedVerdict } = await importTypeScript('src/content/cses-adapter.ts');

  // Text verdicts
  assert.equal(isAcceptedVerdict('ACCEPTED'), true);
  assert.equal(isAcceptedVerdict('accepted'), true);
  assert.equal(isAcceptedVerdict('ac'), true);

  // STRICT REQUIREMENT: READY alone indicates tests finished running, NOT that the solution is accepted
  assert.equal(isAcceptedVerdict('READY'), false);
  assert.equal(isAcceptedVerdict('ready'), false);
  assert.equal(isAcceptedVerdict('READY', null), false);
  assert.equal(isAcceptedVerdict('READY', '0 / 100'), false);
  assert.equal(isAcceptedVerdict('READY', '50 / 100'), false);
  // READY with full score is accepted
  assert.equal(isAcceptedVerdict('READY', '100 / 100'), true);
  assert.equal(isAcceptedVerdict('READY', '100'), true);

  // Class names from DOM
  assert.equal(isAcceptedVerdict('verdict ac'), true);
  assert.equal(isAcceptedVerdict('task-score full'), true);
  assert.equal(isAcceptedVerdict('full'), true);

  // Score representations
  assert.equal(isAcceptedVerdict(null, '100 / 100'), true);
  assert.equal(isAcceptedVerdict(null, '100/100'), true);
  assert.equal(isAcceptedVerdict(null, '100'), true);
  assert.equal(isAcceptedVerdict(null, '100 pts'), true);
  assert.equal(isAcceptedVerdict(null, '100 points'), true);
  assert.equal(isAcceptedVerdict('ACCEPTED', '100 / 100'), true);

  // Non-accepted verdicts
  assert.equal(isAcceptedVerdict('WRONG ANSWER'), false);
  assert.equal(isAcceptedVerdict('wa'), false);
  assert.equal(isAcceptedVerdict('verdict wa'), false);
  assert.equal(isAcceptedVerdict('TIME LIMIT EXCEEDED'), false);
  assert.equal(isAcceptedVerdict('tle'), false);
  assert.equal(isAcceptedVerdict('RUNTIME ERROR'), false);
  assert.equal(isAcceptedVerdict('rte'), false);
  assert.equal(isAcceptedVerdict('MEMORY LIMIT EXCEEDED'), false);
  assert.equal(isAcceptedVerdict('mle'), false);
  assert.equal(isAcceptedVerdict('COMPILE ERROR'), false);
  assert.equal(isAcceptedVerdict('PENDING'), false);
  assert.equal(isAcceptedVerdict('TESTING 50%'), false);

  // Non-accepted scores
  assert.equal(isAcceptedVerdict(null, '0 / 100'), false);
  assert.equal(isAcceptedVerdict(null, '50 / 100'), false);
  assert.equal(isAcceptedVerdict(null, '0 pts'), false);
  assert.equal(isAcceptedVerdict(null, '0'), false);

  // Null / empty
  assert.equal(isAcceptedVerdict(null, null), false);
  assert.equal(isAcceptedVerdict('', ''), false);
  assert.equal(isAcceptedVerdict(undefined, undefined), false);
});

test('parseTimestamp parses CSES timestamp format into UTC millisecond epochs', async () => {
  const { parseTimestamp } = await importTypeScript('src/content/cses-adapter.ts');

  // Exact UTC expectation for CSES "YYYY-MM-DD HH:mm:ss"
  const expectedUtc = Date.UTC(2026, 9, 2, 17, 53, 32); // month 9 is October (0-indexed)
  assert.equal(parseTimestamp('2026-10-02 17:53:32'), expectedUtc);

  const expectedOlder = Date.UTC(2021, 7, 15, 9, 10, 5); // month 7 is August
  assert.equal(parseTimestamp('2021-08-15 09:10:05'), expectedOlder);

  // ISO formats with timezone
  const isoUtc = Date.parse('2026-10-02T17:53:32Z');
  assert.equal(parseTimestamp('2026-10-02T17:53:32Z'), isoUtc);

  // Invalid / null
  assert.equal(parseTimestamp('not a date'), null);
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp(undefined), null);
});

test('extractSourceCode cleanly extracts code from Google Code Prettify <ol class="linenums"> DOM', async () => {
  const { extractSourceCode } = await importTypeScript('src/content/cses-adapter.ts');

  const pre = new SimpleElement('pre', { class: 'prettyprint linenums' });
  const ol = new SimpleElement('ol', { class: 'linenums' });
  const li0 = new SimpleElement('li', { class: 'L0' });
  li0.textContent = '#include <iostream>';
  const li1 = new SimpleElement('li', { class: 'L1' });
  li1.textContent = 'using namespace std;';
  const li2 = new SimpleElement('li', { class: 'L2' });
  li2.textContent = 'int main() {';
  const li3 = new SimpleElement('li', { class: 'L3' });
  li3.textContent = '    cout << "Hello\\n";';
  const li4 = new SimpleElement('li', { class: 'L4' });
  li4.textContent = '}';

  ol.children.push(li0, li1, li2, li3, li4);
  pre.children.push(ol);

  const code = extractSourceCode(pre);
  const expected = [
    '#include <iostream>',
    'using namespace std;',
    'int main() {',
    '    cout << "Hello\\n";',
    '}',
  ].join('\n');

  assert.equal(code, expected);
});

test('extractSourceCode cleanly extracts code from custom <div class="linenums"> DOM', async () => {
  const { extractSourceCode } = await importTypeScript('src/content/cses-adapter.ts');

  const pre = new SimpleElement('pre', { class: 'prettyprint linenums' });
  const div = new SimpleElement('div', { class: 'linenums' });
  const row1 = new SimpleElement('div');
  row1.textContent = 'def solve():';
  const row2 = new SimpleElement('div');
  row2.textContent = '    pass';

  div.children.push(row1, row2);
  pre.children.push(div);

  const code = extractSourceCode(pre);
  assert.equal(code, 'def solve():\n    pass');
});

test('extractSourceCode cleanly extracts code from plain <pre> element without linenums', async () => {
  const { extractSourceCode } = await importTypeScript('src/content/cses-adapter.ts');

  const pre = new SimpleElement('pre');
  pre.textContent = 'print("CSES Weird Algorithm")';

  const code = extractSourceCode(pre);
  assert.equal(code, 'print("CSES Weird Algorithm")');
});

test('extractSourceCode unescapes HTML markup and handles string input', async () => {
  const { extractSourceCode } = await importTypeScript('src/content/cses-adapter.ts');

  const markup = `
    <pre class="prettyprint linenums">
      <ol class="linenums">
        <li class="L0"><span class="kwd">#include</span> &lt;vector&gt;</li>
        <li class="L1">std::vector&lt;int&gt; v;</li>
        <li class="L2"><span class="com">// test &amp; verify</span></li>
      </ol>
    </pre>
  `;

  const code = extractSourceCode(markup);
  assert.equal(code, '#include <vector>\nstd::vector<int> v;\n// test & verify');
});

test('extractSourceCode handles null, empty, and invalid inputs gracefully', async () => {
  const { extractSourceCode } = await importTypeScript('src/content/cses-adapter.ts');

  assert.equal(extractSourceCode(null), '');
  assert.equal(extractSourceCode(undefined), '');
  assert.equal(extractSourceCode(''), '');
});

// ── Result Page DOM Parsing Tests ───────────────────────────────────────────

test('extractUsername extracts username from logged-in header and returns null when logged out', async () => {
  const { extractUsername } = await importTypeScript('src/content/cses-adapter.ts');

  // Logged-in header
  const loggedInDoc = parseHtml(`
    <div class="header">
      <div>
        <a href="/" class="logo"><img src="/logo.png" /></a>
        <div class="controls">
          <a class="account" href="/user/12345">pllk</a>
          <a href="/darkmode">Dark mode</a>
        </div>
      </div>
    </div>
  `);
  assert.equal(extractUsername(loggedInDoc), 'pllk');

  // Logged-out header
  const loggedOutDoc = parseHtml(`
    <div class="header">
      <div>
        <a href="/" class="logo"><img src="/logo.png" /></a>
        <div class="controls">
          <a class="account" href="/login">Login</a>
          <a href="/darkmode">Dark mode</a>
        </div>
      </div>
    </div>
  `);
  assert.equal(extractUsername(loggedOutDoc), null);

  assert.equal(extractUsername(null), null);
});

test('parseResultPage extracts full metadata for an Accepted submission', async () => {
  const { parseResultPage } = await importTypeScript('src/content/cses-adapter.ts');

  const html = `
    <div>
      <div class="header">
        <div>
          <div class="controls">
            <a class="account" href="/user/9876">senthil_kumar</a>
          </div>
        </div>
      </div>
      <div class="navigation">
        <div class="title-block">
          <h3><a href="/problemset/list/">CSES Problem Set</a></h3>
          <h1>Weird Algorithm</h1>
        </div>
      </div>
      <div class="content">
        <table class="summary-table">
          <tbody>
            <tr><td>Task:</td><td><a href="/problemset/task/1068">Weird Algorithm</a></td></tr>
            <tr><td>Sender:</td><td><a href="/user/9876">senthil_kumar</a></td></tr>
            <tr><td>Time:</td><td>2026-10-02 17:53:32</td></tr>
            <tr><td>Compiler:</td><td>C++17</td></tr>
            <tr><td>Status:</td><td id="status">READY</td></tr>
            <tr><td>Result:</td><td><span class="verdict ac">ACCEPTED</span></td></tr>
            <tr><td>Score:</td><td>100 / 100</td></tr>
          </tbody>
        </table>
        <pre class="prettyprint linenums">
          <ol class="linenums">
            <li class="L0">#include &lt;iostream&gt;</li>
            <li class="L1">using namespace std;</li>
            <li class="L2">int main() { return 0; }</li>
          </ol>
        </pre>
      </div>
    </div>
  `;

  const doc = parseHtml(html);
  const result = parseResultPage(doc, { url: 'https://cses.fi/problemset/result/3889109/' });

  assert.ok(result !== null);
  assert.equal(result.submissionId, '3889109');
  assert.equal(result.problemId, '1068');
  assert.equal(result.problemTitle, 'Weird Algorithm');
  assert.equal(result.username, 'senthil_kumar');
  assert.equal(result.verdict, 'ACCEPTED');
  assert.equal(result.score, '100 / 100');
  assert.equal(result.isAccepted, true);
  assert.equal(result.language, 'C++17');
  assert.equal(result.submittedAt, '2026-10-02 17:53:32');
  assert.equal(result.timestamp, Date.UTC(2026, 9, 2, 17, 53, 32));
  assert.equal(result.code, '#include <iostream>\nusing namespace std;\nint main() { return 0; }');
});

test('parseResultPage parses Wrong Answer submission correctly with isAccepted=false', async () => {
  const { parseResultPage } = await importTypeScript('src/content/cses-adapter.ts');

  const html = `
    <div>
      <div class="header">
        <div class="controls"><a class="account" href="/user/1">pllk</a></div>
      </div>
      <div class="content">
        <table class="summary-table">
          <tbody>
            <tr><td>Task:</td><td><a href="/problemset/task/1083">Missing Number</a></td></tr>
            <tr><td>Time:</td><td>2026-10-03 10:00:00</td></tr>
            <tr><td>Compiler:</td><td>Python3</td></tr>
            <tr><td>Status:</td><td id="status">READY</td></tr>
            <tr><td>Result:</td><td><span class="verdict wa">WRONG ANSWER</span></td></tr>
            <tr><td>Score:</td><td>0 / 100</td></tr>
          </tbody>
        </table>
        <pre class="prettyprint">print(42)</pre>
      </div>
    </div>
  `;

  const doc = parseHtml(html);
  const result = parseResultPage(doc, { url: '/problemset/result/4000123/' });

  assert.ok(result !== null);
  assert.equal(result.submissionId, '4000123');
  assert.equal(result.problemId, '1083');
  assert.equal(result.problemTitle, 'Missing Number');
  assert.equal(result.verdict, 'WRONG ANSWER');
  assert.equal(result.score, '0 / 100');
  assert.equal(result.isAccepted, false);
  assert.equal(result.language, 'Python3');
  assert.equal(result.code, 'print(42)');
});

test('parseResultPage rejects READY status alone when verdict or score is not accepted', async () => {
  const { parseResultPage } = await importTypeScript('src/content/cses-adapter.ts');

  // Case A: Status is READY, no Result row, no Score row
  const htmlWithoutResult = `
    <div>
      <div class="header">
        <div class="controls"><a class="account" href="/user/1">pllk</a></div>
      </div>
      <div class="content">
        <table class="summary-table">
          <tbody>
            <tr><td>Task:</td><td><a href="/problemset/task/1069">Repetitions</a></td></tr>
            <tr><td>Compiler:</td><td>C++20</td></tr>
            <tr><td>Status:</td><td id="status">READY</td></tr>
          </tbody>
        </table>
        <pre>int main() {}</pre>
      </div>
    </div>
  `;

  const docA = parseHtml(htmlWithoutResult);
  const resultA = parseResultPage(docA, { url: '/problemset/result/5000001/' });

  assert.ok(resultA !== null);
  assert.equal(resultA.isAccepted, false, 'READY alone must not mean accepted');
  assert.equal(resultA.verdict, 'READY');

  // Case B: Status is READY, Result is TIME LIMIT EXCEEDED
  const htmlTle = `
    <div>
      <div class="content">
        <table class="summary-table">
          <tbody>
            <tr><td>Task:</td><td><a href="/problemset/task/1069">Repetitions</a></td></tr>
            <tr><td>Status:</td><td id="status">READY</td></tr>
            <tr><td>Result:</td><td><span class="verdict tle">TIME LIMIT EXCEEDED</span></td></tr>
            <tr><td>Score:</td><td>0 / 100</td></tr>
          </tbody>
        </table>
        <pre>while(true);</pre>
      </div>
    </div>
  `;

  const docB = parseHtml(htmlTle);
  const resultB = parseResultPage(docB, { url: '/problemset/result/5000002/' });

  assert.ok(resultB !== null);
  assert.equal(resultB.isAccepted, false);
  assert.equal(resultB.verdict, 'TIME LIMIT EXCEEDED');
});

test('parseResultPage parses in-progress (TESTING / PENDING) submission with isAccepted=false', async () => {
  const { parseResultPage } = await importTypeScript('src/content/cses-adapter.ts');

  const html = `
    <div>
      <div class="content">
        <table class="summary-table">
          <tbody>
            <tr><td>Task:</td><td><a href="/problemset/task/1070">Permutations</a></td></tr>
            <tr><td>Status:</td><td id="status">TESTING 40%</td></tr>
            <tr><td>Result:</td><td>PENDING</td></tr>
          </tbody>
        </table>
        <pre># code</pre>
      </div>
    </div>
  `;

  const doc = parseHtml(html);
  const result = parseResultPage(doc, { url: '/problemset/result/6000001/' });

  assert.ok(result !== null);
  assert.equal(result.isAccepted, false);
});

test('parseResultPage handles logged-out visitor with username=null', async () => {
  const { parseResultPage } = await importTypeScript('src/content/cses-adapter.ts');

  const html = `
    <div>
      <div class="header">
        <div class="controls"><a class="account" href="/login">Login</a></div>
      </div>
      <div class="content">
        <table class="summary-table">
          <tbody>
            <tr><td>Task:</td><td><a href="/problemset/task/1068">Weird Algorithm</a></td></tr>
            <tr><td>Result:</td><td><span class="verdict ac">ACCEPTED</span></td></tr>
          </tbody>
        </table>
        <pre># code</pre>
      </div>
    </div>
  `;

  const doc = parseHtml(html);
  const result = parseResultPage(doc, { url: '/problemset/result/7000001/' });

  assert.ok(result !== null);
  assert.equal(result.username, null);
  assert.equal(result.isAccepted, true);
});

test('parseResultPage returns null when required fields (submissionId or problemId) are missing', async () => {
  const { parseResultPage } = await importTypeScript('src/content/cses-adapter.ts');

  // Missing submission ID
  const htmlNoSubId = `
    <div>
      <table class="summary-table">
        <tbody>
          <tr><td>Task:</td><td><a href="/problemset/task/1068">Weird Algorithm</a></td></tr>
        </tbody>
      </table>
    </div>
  `;
  assert.equal(parseResultPage(parseHtml(htmlNoSubId), { url: '/problemset/list' }), null);

  // Missing problem link
  const htmlNoProblem = `
    <div>
      <table class="summary-table">
        <tbody>
          <tr><td>Status:</td><td>READY</td></tr>
        </tbody>
      </table>
    </div>
  `;
  assert.equal(parseResultPage(parseHtml(htmlNoProblem), { url: '/problemset/result/123/' }), null);

  // Null input
  assert.equal(parseResultPage(null), null);
});

// ── Topic / Category Resolution Tests ──────────────────────────────────────

test('parseProblemsetCategories extracts categories and problem IDs from problemset list HTML and DOM', async () => {
  const { parseProblemsetCategories } = await importTypeScript('src/content/cses-adapter.ts');

  const html = `
    <h2>General</h2>
    <ul class="task-list">
      <li class="text"><a href="/problemset/text/2433">Introduction</a></li>
    </ul>
    <h2>Introductory Problems</h2>
    <ul class="task-list">
      <li class="task"><a href="/problemset/task/1068">Weird Algorithm</a></li>
      <li class="task"><a href="/problemset/task/1083">Missing Number</a></li>
      <li class="task"><a href="/problemset/task/1069">Repetitions</a></li>
    </ul>
    <h2>Sorting and Searching</h2>
    <ul class="task-list">
      <li class="task"><a href="/problemset/task/1621">Distinct Numbers</a></li>
      <li class="task"><a href="/problemset/task/1084">Apartments</a></li>
    </ul>
    <h2>Dynamic Programming</h2>
    <ul class="task-list">
      <li class="task"><a href="/problemset/task/1633">Dice Combinations</a></li>
    </ul>
  `;

  // Test with string input
  const mappingFromString = parseProblemsetCategories(html);
  assert.equal(mappingFromString['1068'], 'Introductory Problems');
  assert.equal(mappingFromString['1083'], 'Introductory Problems');
  assert.equal(mappingFromString['1069'], 'Introductory Problems');
  assert.equal(mappingFromString['1621'], 'Sorting and Searching');
  assert.equal(mappingFromString['1084'], 'Sorting and Searching');
  assert.equal(mappingFromString['1633'], 'Dynamic Programming');
  assert.equal(mappingFromString['2433'], undefined); // General text skipped

  // Test with DOM input
  const doc = parseHtml(html);
  const mappingFromDoc = parseProblemsetCategories(doc);
  assert.equal(mappingFromDoc['1068'], 'Introductory Problems');
  assert.equal(mappingFromDoc['1621'], 'Sorting and Searching');
  assert.equal(mappingFromDoc['1633'], 'Dynamic Programming');
});

test('parseProblemsetCategories extracts category from task sidebar DOM', async () => {
  const { parseProblemsetCategories } = await importTypeScript('src/content/cses-adapter.ts');

  const sidebarHtml = `
    <div class="nav sidebar">
      <h4>Introductory Problems</h4>
      <a class="current" href="/problemset/task/1068">Weird Algorithm</a>
      <a href="/problemset/task/1083">Missing Number</a>
      <hr />
      <h4>Your submissions</h4>
      <a href="/problemset/result/123/">Sub 1</a>
    </div>
  `;

  const doc = parseHtml(sidebarHtml);
  const mapping = parseProblemsetCategories(doc);
  assert.equal(mapping['1068'], 'Introductory Problems');
  assert.equal(mapping['1083'], 'Introductory Problems');
  assert.equal(mapping['123'], undefined); // Your submissions skipped
});

test('local topic caching: saveTopicsToCache, getCachedTopic, and clearTopicCache', async () => {
  const { saveTopicsToCache, getCachedTopic, clearTopicCache } = await importTypeScript(
    'src/content/cses-adapter.ts'
  );

  clearTopicCache();
  assert.equal(getCachedTopic('1068'), null);

  await saveTopicsToCache({
    '1068': 'Introductory Problems',
    '1621': 'Sorting and Searching',
  });

  assert.equal(getCachedTopic('1068'), 'Introductory Problems');
  assert.equal(getCachedTopic('1621'), 'Sorting and Searching');
  assert.equal(getCachedTopic('9999'), null);

  clearTopicCache();
  assert.equal(getCachedTopic('1068'), null);
});

test('resolveProblemTopic resolves from memory cache and problemsetDoc', async () => {
  const { resolveProblemTopic, clearTopicCache } = await importTypeScript(
    'src/content/cses-adapter.ts'
  );

  clearTopicCache();

  // Test resolution from provided problemsetDoc
  const html = `
    <h2>Tree Algorithms</h2>
    <ul class="task-list">
      <li class="task"><a href="/problemset/task/1674">Subordinates</a></li>
    </ul>
  `;
  const doc = parseHtml(html);
  const topic = await resolveProblemTopic('1674', { problemsetDoc: doc });
  assert.equal(topic, 'Tree Algorithms');

  // Should now be cached in memory
  const cachedTopic = await resolveProblemTopic('1674');
  assert.equal(cachedTopic, 'Tree Algorithms');
});

test('resolveProblemTopic resolves via fetchFn when not in cache', async () => {
  const { resolveProblemTopic, clearTopicCache } = await importTypeScript(
    'src/content/cses-adapter.ts'
  );

  clearTopicCache();

  const mockResponseHtml = `
    <h2>Graph Algorithms</h2>
    <ul class="task-list">
      <li class="task"><a href="/problemset/task/1192">Counting Rooms</a></li>
    </ul>
  `;

  const mockFetch = async (url) => {
    assert.ok(url.includes('/problemset/list'));
    return {
      ok: true,
      text: async () => mockResponseHtml,
    };
  };

  const topic = await resolveProblemTopic('1192', { fetchFn: mockFetch });
  assert.equal(topic, 'Graph Algorithms');

  // Verify it was cached in memory
  const topic2 = await resolveProblemTopic('1192');
  assert.equal(topic2, 'Graph Algorithms');
});

test('resolveProblemTopic fails safely to "Uncategorized" on network errors or unknown tasks', async () => {
  const { resolveProblemTopic, clearTopicCache, DEFAULT_CSES_TOPIC } = await importTypeScript(
    'src/content/cses-adapter.ts'
  );

  clearTopicCache();

  // Network fetch error fails safe to Uncategorized
  const failingFetch = async () => {
    throw new Error('Network error');
  };
  const topicError = await resolveProblemTopic('99999', { fetchFn: failingFetch });
  assert.equal(topicError, DEFAULT_CSES_TOPIC);
  assert.equal(topicError, 'Uncategorized');

  // Unknown problem ID with valid fetch fails safe to Uncategorized
  const emptyFetch = async () => ({
    ok: true,
    text: async () => '<h2>Introductory Problems</h2><ul class="task-list"><li class="task"><a href="/problemset/task/1068">Weird</a></li></ul>',
  });
  const topicUnknown = await resolveProblemTopic('88888', { fetchFn: emptyFetch });
  assert.equal(topicUnknown, 'Uncategorized');

  // Null, undefined, empty ID fails safe immediately
  assert.equal(await resolveProblemTopic(null), 'Uncategorized');
  assert.equal(await resolveProblemTopic(''), 'Uncategorized');
  assert.equal(await resolveProblemTopic(undefined), 'Uncategorized');
});

// ── Runtime Pipeline Tests ──────────────────────────────────────────────────

test('isResultPage correctly identifies CSES result URL paths', async () => {
  const { isResultPage } = await importTypeScript('src/content/cses-adapter.ts');

  assert.equal(isResultPage('/problemset/result/3889109/'), true);
  assert.equal(isResultPage('/problemset/result/3889109'), true);
  assert.equal(isResultPage('/course/result/123/'), true);
  assert.equal(isResultPage('/result/456'), true);

  // Non-result pages
  assert.equal(isResultPage('/problemset/task/1068'), false);
  assert.equal(isResultPage('/problemset/list'), false);
  assert.equal(isResultPage('/login'), false);
  assert.equal(isResultPage('/user/1'), false);
  assert.equal(isResultPage(''), false);
  assert.equal(isResultPage(null), false);
  assert.equal(isResultPage(undefined), false);
});

test('submissionFromResultData creates a valid normalized Submission payload', async () => {
  const { submissionFromResultData } = await importTypeScript('src/content/cses-adapter.ts');

  const data = {
    submissionId: '3889109',
    problemId: '1068',
    problemTitle: 'Weird Algorithm',
    username: 'senthil',
    verdict: 'ACCEPTED',
    score: '100 / 100',
    isAccepted: true,
    language: 'C++17',
    submittedAt: '2026-10-02 17:53:32',
    timestamp: 1790963612000,
    code: 'int main() {}',
    topic: 'Introductory Problems',
  };

  const sub = submissionFromResultData(data, 'https://cses.fi');
  assert.equal(sub.platform, 'cses');
  assert.equal(sub.submissionId, '3889109');
  assert.equal(sub.problemId, '1068');
  assert.equal(sub.problemTitle, 'Weird Algorithm');
  assert.equal(sub.language, 'C++17');
  assert.equal(sub.sourceCode, 'int main() {}');
  assert.equal(sub.verdict, 'accepted');
  assert.equal(sub.submittedAt, '2026-10-02 17:53:32');
  assert.equal(sub.problemUrl, 'https://cses.fi/problemset/task/1068');
  assert.equal(sub.topic, 'Introductory Problems');
});

test('processResultPage queues accepted submission and prevents duplicates', async () => {
  const { processResultPage } = await importTypeScript('src/content/cses-adapter.ts');

  const html = `
    <div>
      <div class="header">
        <div class="controls"><a class="account" href="/user/1">pllk</a></div>
      </div>
      <div class="content">
        <table class="summary-table">
          <tbody>
            <tr><td>Task:</td><td><a href="/problemset/task/1068">Weird Algorithm</a></td></tr>
            <tr><td>Time:</td><td>2026-10-02 17:53:32</td></tr>
            <tr><td>Compiler:</td><td>C++17</td></tr>
            <tr><td>Status:</td><td id="status">READY</td></tr>
            <tr><td>Result:</td><td><span class="verdict ac">ACCEPTED</span></td></tr>
            <tr><td>Score:</td><td>100 / 100</td></tr>
          </tbody>
        </table>
        <pre># code</pre>
      </div>
    </div>
  `;

  const doc = parseHtml(html);
  const observed = new Set();
  const queuedSubmissions = [];

  const mockQueueFn = async (submission) => {
    queuedSubmissions.push(submission);
    return { queued: true };
  };

  const outcome1 = await processResultPage(doc, {
    url: 'https://cses.fi/problemset/result/3889109/',
    observed,
    queueFn: mockQueueFn,
    resolveTopicFn: async () => 'Introductory Problems',
  });

  assert.equal(outcome1.status, 'queued');
  assert.equal(queuedSubmissions.length, 1);
  assert.equal(queuedSubmissions[0].submissionId, '3889109');
  assert.equal(queuedSubmissions[0].topic, 'Introductory Problems');
  assert.ok(observed.has('3889109'));

  // Duplicate scan: should not re-queue
  const outcome2 = await processResultPage(doc, {
    url: 'https://cses.fi/problemset/result/3889109/',
    observed,
    queueFn: mockQueueFn,
    resolveTopicFn: async () => 'Introductory Problems',
  });

  assert.equal(outcome2.status, 'duplicate');
  assert.equal(queuedSubmissions.length, 1, 'Duplicate must not be re-queued');
});

test('processResultPage handles pending/testing transitions without premature duplicate marking', async () => {
  const { processResultPage } = await importTypeScript('src/content/cses-adapter.ts');

  // Step 1: In-progress testing page
  const testingHtml = `
    <div>
      <div class="content">
        <table class="summary-table">
          <tbody>
            <tr><td>Task:</td><td><a href="/problemset/task/1083">Missing Number</a></td></tr>
            <tr><td>Status:</td><td id="status">TESTING 40%</td></tr>
            <tr><td>Result:</td><td>PENDING</td></tr>
          </tbody>
        </table>
        <pre># testing code</pre>
      </div>
    </div>
  `;

  const testingDoc = parseHtml(testingHtml);
  const observed = new Set();
  let queuedCount = 0;
  const mockQueueFn = async () => {
    queuedCount++;
    return { queued: true };
  };

  const outcomePending = await processResultPage(testingDoc, {
    url: 'https://cses.fi/problemset/result/4000001/',
    observed,
    queueFn: mockQueueFn,
  });

  assert.equal(outcomePending.status, 'pending');
  assert.equal(queuedCount, 0);
  assert.equal(observed.has('4000001'), false, 'In-progress submission must NOT be marked in observed set');

  // Step 2: Page transitions to READY + ACCEPTED
  const acceptedHtml = `
    <div>
      <div class="content">
        <table class="summary-table">
          <tbody>
            <tr><td>Task:</td><td><a href="/problemset/task/1083">Missing Number</a></td></tr>
            <tr><td>Status:</td><td id="status">READY</td></tr>
            <tr><td>Result:</td><td><span class="verdict ac">ACCEPTED</span></td></tr>
            <tr><td>Score:</td><td>100 / 100</td></tr>
          </tbody>
        </table>
        <pre># testing code</pre>
      </div>
    </div>
  `;

  const acceptedDoc = parseHtml(acceptedHtml);
  const outcomeAccepted = await processResultPage(acceptedDoc, {
    url: 'https://cses.fi/problemset/result/4000001/',
    observed,
    queueFn: mockQueueFn,
    resolveTopicFn: async () => 'Introductory Problems',
  });

  assert.equal(outcomeAccepted.status, 'queued');
  assert.equal(queuedCount, 1);
  assert.equal(observed.has('4000001'), true);
});

test('processResultPage skips queue for rejected submissions and marks observed', async () => {
  const { processResultPage } = await importTypeScript('src/content/cses-adapter.ts');

  const waHtml = `
    <div>
      <div class="content">
        <table class="summary-table">
          <tbody>
            <tr><td>Task:</td><td><a href="/problemset/task/1069">Repetitions</a></td></tr>
            <tr><td>Status:</td><td id="status">READY</td></tr>
            <tr><td>Result:</td><td><span class="verdict wa">WRONG ANSWER</span></td></tr>
            <tr><td>Score:</td><td>0 / 100</td></tr>
          </tbody>
        </table>
        <pre># code</pre>
      </div>
    </div>
  `;

  const doc = parseHtml(waHtml);
  const observed = new Set();
  let queuedCount = 0;

  const outcome = await processResultPage(doc, {
    url: 'https://cses.fi/problemset/result/5000001/',
    observed,
    queueFn: async () => {
      queuedCount++;
      return { queued: true };
    },
  });

  assert.equal(outcome.status, 'rejected');
  assert.equal(queuedCount, 0, 'Rejected submission must not be queued');
  assert.equal(observed.has('5000001'), true, 'Terminal non-accepted submission is marked observed');
});


