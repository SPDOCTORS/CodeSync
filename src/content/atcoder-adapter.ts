// Pure parsing helpers for the AtCoder content script adapter foundation.
// No browser globals required — safe to import in tests and content scripts alike.

import type { Submission } from '../lib/types';

export interface AtCoderSubmissionUrlInfo {
  contestId: string;
  submissionId: string;
}

export interface AtCoderTaskUrlInfo {
  contestId: string;
  taskId: string;
}

export interface AtCoderSubmissionPageData {
  submissionId: string;
  contestId: string;
  taskId: string;
  problemTitle: string;
  author: string | null;
  username: string | null;
  isOwner: boolean;
  verdict: string;
  isAccepted: boolean;
  score: string | null;
  language: string;
  submittedAt: string | null;
  timestamp: number | null;
  code: string;
}

/**
 * Extracts contest ID and submission ID from an AtCoder submission URL or path.
 * Matches:
 *   - https://atcoder.jp/contests/abc375/submissions/58392104
 *   - https://atcoder.jp/contests/abc375/submissions/58392104/
 *   - /contests/abc375/submissions/58392104
 *   - /contests/arc180/submissions/58392104?f.User=tourist
 */
export function parseSubmissionUrl(rawUrl: string | null | undefined): AtCoderSubmissionUrlInfo | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  const match = trimmed.match(/(?:^|\/)contests\/([a-zA-Z0-9_.-]+)\/submissions\/(\d+)(?:\/)?(?:[?#].*)?$/i);
  if (!match || !match[1] || !match[2]) return null;
  return {
    contestId: match[1],
    submissionId: match[2],
  };
}

/**
 * Extracts contest ID and task ID from an AtCoder task URL or path.
 * Matches:
 *   - https://atcoder.jp/contests/abc375/tasks/abc375_a
 *   - https://atcoder.jp/contests/abc375/tasks/abc375_a/
 *   - /contests/abc375/tasks/abc375_a
 *   - /contests/practice/tasks/practice_1
 */
export function parseTaskUrl(rawUrl: string | null | undefined): AtCoderTaskUrlInfo | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  const match = trimmed.match(/(?:^|\/)contests\/([a-zA-Z0-9_.-]+)\/tasks\/([a-zA-Z0-9_.-]+)(?:\/)?(?:[?#].*)?$/i);
  if (!match || !match[1] || !match[2]) return null;
  return {
    contestId: match[1],
    taskId: match[2],
  };
}

/**
 * Common non-AC status codes on AtCoder:
 * WA: Wrong Answer
 * TLE: Time Limit Exceeded
 * MLE: Memory Limit Exceeded
 * OLE: Output Limit Exceeded
 * RE: Runtime Error
 * CE: Compilation Error
 * QLE: Query Limit Exceeded
 * WJ: Waiting for Judging
 * WR: Waiting for Re-judging
 * In-progress: judging indicators like [1/30], 1/30, etc.
 */
const NON_AC_PATTERNS = /\b(?:wa|tle|mle|ole|re|ce|qle|wj|wr|judging|waiting|\d+\/\d+)\b/i;

/**
 * Returns true if the verdict text or CSS classes indicate an Accepted (AC) verdict.
 * AtCoder uses the string "AC" and badge class "label-success".
 */
export function isAcceptedVerdict(
  verdict: string | null | undefined,
  badgeClass?: string | null | undefined,
): boolean {
  if (!verdict && !badgeClass) return false;

  const rawVerdict = (verdict ?? '').trim();
  const rawClass = (badgeClass ?? '').trim();

  // If there's an explicit non-AC marker anywhere in verdict or class, reject
  if (NON_AC_PATTERNS.test(rawVerdict) || NON_AC_PATTERNS.test(rawClass)) {
    return false;
  }

  // Exact AC match
  if (rawVerdict.toUpperCase() === 'AC') {
    return true;
  }

  // Bootstrap label-success or badge-success with AC wording
  if (/\b(?:label-success|badge-success)\b/i.test(rawClass)) {
    if (/\bac\b/i.test(rawVerdict) || !rawVerdict) {
      return true;
    }
  }

  // Check word boundary \bAC\b in verdict without negative words
  if (/\bAC\b/.test(rawVerdict)) {
    return true;
  }

  return false;
}

/**
 * Normalizes AtCoder compiler/language strings into clean canonical language identifiers
 * and extensions compatible with CodeSync's pathFor conventions.
 *
 * Examples of AtCoder compiler strings:
 *   - "C++ 20 (gcc 12.2)" -> { name: "C++ 20", extension: "cpp" }
 *   - "C++ 23 (gcc 12.2)" -> { name: "C++ 23", extension: "cpp" }
 *   - "C++ (GCC 9.2.1)" -> { name: "C++", extension: "cpp" }
 *   - "Python (CPython 3.11.4)" -> { name: "Python 3", extension: "py" }
 *   - "Python (PyPy 3.10-v7.3.12)" -> { name: "PyPy 3", extension: "py" }
 *   - "Java (OpenJDK 17)" -> { name: "Java 17", extension: "java" }
 *   - "Java (OpenJDK 11.0.6)" -> { name: "Java 11", extension: "java" }
 *   - "Rust (rustc 1.70.0)" -> { name: "Rust", extension: "rs" }
 *   - "Go (go 1.20.6)" -> { name: "Go", extension: "go" }
 *   - "C# 11.0 (.NET 7.0.7)" -> { name: "C#", extension: "cs" }
 *   - "Kotlin (Kotlin/JVM 1.8.20)" -> { name: "Kotlin", extension: "kt" }
 *   - "JavaScript (Node.js 18.16.1)" -> { name: "JavaScript", extension: "js" }
 *   - "TypeScript (Node.js 18.16.1)" -> { name: "TypeScript", extension: "ts" }
 *   - "C (GCC 12.2.0)" -> { name: "C", extension: "c" }
 */
export function normalizeLanguage(rawLang: string | null | undefined): { name: string; extension: string } {
  if (!rawLang || !rawLang.trim()) {
    return { name: 'Unknown', extension: 'txt' };
  }

  const s = rawLang.trim();
  const lower = s.toLowerCase();

  // Python / PyPy
  if (lower.includes('pypy')) {
    return { name: s.split('(')[0].trim() || 'PyPy 3', extension: 'py' };
  }
  if (lower.startsWith('python') || lower.includes('cpython')) {
    return { name: s.split('(')[0].trim() || 'Python 3', extension: 'py' };
  }

  // C++
  if (lower.includes('c++')) {
    const base = s.split('(')[0].trim();
    return { name: base || 'C++', extension: 'cpp' };
  }

  // C
  if (lower === 'c' || lower.startsWith('c ') || lower.startsWith('c(') || lower.includes('c (gcc') || lower.includes('c (clang')) {
    return { name: 'C', extension: 'c' };
  }

  // JavaScript
  if (lower.startsWith('javascript')) {
    return { name: 'JavaScript', extension: 'js' };
  }

  // TypeScript
  if (lower.startsWith('typescript')) {
    return { name: 'TypeScript', extension: 'ts' };
  }

  // Java
  if (lower.startsWith('java')) {
    const base = s.split('(')[0].trim();
    return { name: base || 'Java', extension: 'java' };
  }

  // Rust
  if (lower.startsWith('rust')) {
    return { name: 'Rust', extension: 'rs' };
  }

  // Go
  if (lower.startsWith('go') || lower.includes('(go ')) {
    return { name: 'Go', extension: 'go' };
  }

  // C# / .NET
  if (lower.startsWith('c#') || lower.startsWith('csharp')) {
    return { name: 'C#', extension: 'cs' };
  }

  // Kotlin
  if (lower.startsWith('kotlin')) {
    return { name: 'Kotlin', extension: 'kt' };
  }

  // Swift
  if (lower.startsWith('swift')) {
    return { name: 'Swift', extension: 'swift' };
  }

  // Ruby
  if (lower.startsWith('ruby')) {
    return { name: 'Ruby', extension: 'rb' };
  }

  // Scala
  if (lower.startsWith('scala')) {
    return { name: 'Scala', extension: 'scala' };
  }

  // Haskell
  if (lower.startsWith('haskell')) {
    return { name: 'Haskell', extension: 'hs' };
  }

  // OCaml
  if (lower.startsWith('ocaml')) {
    return { name: 'OCaml', extension: 'ml' };
  }

  // PHP
  if (lower.startsWith('php')) {
    return { name: 'PHP', extension: 'php' };
  }

  // D
  if (lower.startsWith('d ') || lower.startsWith('d(')) {
    return { name: 'D', extension: 'd' };
  }

  return { name: s.split('(')[0].trim() || s, extension: 'txt' };
}

/** Decodes common HTML character entities in extracted pre content. */
function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Extracts and unescapes source code from an AtCoder `#submission-code` element or raw string.
 * Supports DOM elements (HTMLPreElement, Element), duck-typed objects with textContent/innerHTML,
 * and raw HTML string input.
 */
export function extractSourceCode(nodeOrHtml: unknown): string {
  if (!nodeOrHtml) return '';

  if (typeof nodeOrHtml === 'object') {
    const el = nodeOrHtml as {
      querySelector?: (sel: string) => unknown;
      textContent?: string | null;
      innerHTML?: string;
    };

    // If container element with #submission-code inside
    const codePre = el.querySelector ? (el.querySelector('#submission-code, pre.prettyprint, pre') as { textContent?: string | null } | null) : null;
    const target = codePre || el;
    const rawText = target.textContent ?? '';
    return decodeHtmlEntities(rawText).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  if (typeof nodeOrHtml === 'string') {
    const raw = nodeOrHtml;
    // Check if wrapped in <pre ...>...</pre>
    const preMatch = raw.match(/<pre\b[^>]*id=["']submission-code["'][^>]*>(.*?)<\/pre>/is)
      || raw.match(/<pre\b[^>]*>(.*?)<\/pre>/is);
    const content = (preMatch ? preMatch[1] : raw).replace(/<[^>]+>/g, '');
    return decodeHtmlEntities(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  return '';
}

/**
 * Safely parses an AtCoder submission date string or timestamp into a Unix epoch millisecond timestamp.
 * AtCoder uses JST (UTC+9) timestamps formatted as `YYYY-MM-DD HH:mm:ss+0900`, `YYYY-MM-DD HH:mm:ss`,
 * or `<time class="fixtime fixtime-full">YYYY-MM-DD HH:mm:ss+0900</time>`.
 *
 * Returns Unix timestamp in milliseconds, or null if parsing fails.
 */
export function parseSubmissionTimestamp(rawDate: string | null | undefined): number | null {
  if (!rawDate) return null;
  const trimmed = rawDate.trim();
  if (!trimmed) return null;

  // Extract from HTML <time> if full element tag is passed
  const timeTagMatch = trimmed.match(/<time\b[^>]*>(.*?)<\/time>/i);
  const dateStr = timeTagMatch ? timeTagMatch[1].trim() : trimmed;

  // Matches YYYY-MM-DD HH:mm:ss(+0900 or Z or offset)
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})[\sT](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:(\+09:?00|Z|[+-]\d{2}:?\d{2}))?$/i);
  if (isoMatch) {
    const [, yr, mo, dy, hr, mi, sc, ms, tz] = isoMatch;
    if (tz) {
      const parsed = Date.parse(dateStr);
      return Number.isNaN(parsed) ? null : parsed;
    }
    // Default AtCoder timestamps without explicit offset are Japan Standard Time (UTC+09:00)
    const jstIso = `${yr}-${mo}-${dy}T${hr}:${mi}:${sc}${ms ? '.' + ms : ''}+09:00`;
    const parsedJst = Date.parse(jstIso);
    if (!Number.isNaN(parsedJst)) {
      return parsedJst;
    }
  }

  const parsed = Date.parse(dateStr);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Extracts the logged-in user's handle from the AtCoder header/navbar.
 * AtCoder header patterns:
 *   - #header a[href^="/users/"]
 *   - #navbar-collapse a[href^="/users/"]
 *   - a.username[href^="/users/"]
 * When logged out, header contains links to "/login" or "/register".
 */
export function extractUsername(root: any): string | null {
  if (!root) return null;

  // Search inside #header or navbar containers first
  const selectors = [
    '#header a[href^="/users/"]',
    '#navbar-collapse a[href^="/users/"]',
    'nav a[href^="/users/"]',
    'header a[href^="/users/"]',
    'a.username[href^="/users/"]',
    'a[href^="/users/"]',
  ];

  for (const sel of selectors) {
    const link = root.querySelector ? root.querySelector(sel) : null;
    if (link) {
      // Check if it's inside the main navbar / header rather than the summary table
      const href = (link.getAttribute ? link.getAttribute('href') : link.href) ?? '';
      const text = (link.textContent ?? '').trim();
      const match = href.match(/\/users\/([a-zA-Z0-9_.-]+)/);
      if (match && match[1] && text && text.toLowerCase() !== 'login') {
        return match[1];
      }
    }
  }

  return null;
}

/**
 * Parses key-value pairs from an AtCoder summary table (`table.table`).
 * Typically contains rows with `th` (label) and `td` (value).
 */
export function extractSummaryRows(table: any): Map<string, { cell: any; text: string }> {
  const map = new Map<string, { cell: any; text: string }>();
  if (!table) return map;

  const rows = table.querySelectorAll ? table.querySelectorAll('tr') : [];
  for (const row of Array.from(rows)) {
    const cells = (row as any).querySelectorAll ? (row as any).querySelectorAll('th, td') : [];
    if (cells.length >= 2) {
      const key = (cells[0].textContent ?? '').trim().replace(/:$/, '').toLowerCase();
      const valText = (cells[1].textContent ?? '').trim();
      map.set(key, { cell: cells[1], text: valText });
    }
  }

  return map;
}

/**
 * Parses an AtCoder submission detail page (`https://atcoder.jp/contests/:contestId/submissions/:submissionId`).
 *
 * Extracts:
 *   - submissionId & contestId (from URL or DOM links)
 *   - taskId & problemTitle (from task link: `a[href*="/tasks/"]`)
 *   - author (from User row: `a[href*="/users/"]`)
 *   - username (logged-in user from header)
 *   - isOwner (strictly author === username)
 *   - verdict & isAccepted (strictly actual verdict AC)
 *   - score (from Score row)
 *   - language (normalized canonical name)
 *   - submittedAt & timestamp (from Submission Date row)
 *   - code (from #submission-code)
 *
 * Returns null if the root is missing or if submissionId, contestId, or taskId cannot be found.
 */
export function parseSubmissionPage(
  root: any,
  options?: { url?: string },
): AtCoderSubmissionPageData | null {
  if (!root) return null;

  // 1. Contest ID & Submission ID
  let contestId: string | null = null;
  let submissionId: string | null = null;

  if (options?.url) {
    const info = parseSubmissionUrl(options.url);
    if (info) {
      contestId = info.contestId;
      submissionId = info.submissionId;
    }
  }

  if (!submissionId || !contestId) {
    const docUrl = root.location?.href || root.baseURI || root.URL || null;
    if (docUrl) {
      const info = parseSubmissionUrl(docUrl);
      if (info) {
        contestId = contestId || info.contestId;
        submissionId = submissionId || info.submissionId;
      }
    }
  }

  if (!submissionId || !contestId) {
    const subLink = root.querySelector
      ? root.querySelector('a.current[href*="/submissions/"], a[href*="/submissions/"]')
      : null;
    if (subLink) {
      const href = (subLink.getAttribute ? subLink.getAttribute('href') : subLink.href) ?? '';
      const info = parseSubmissionUrl(href);
      if (info) {
        contestId = contestId || info.contestId;
        submissionId = submissionId || info.submissionId;
      }
    }
  }

  // 2. Summary Table rows
  const table = root.querySelector ? root.querySelector('table.table, table') : null;
  const rows = extractSummaryRows(table);

  // 3. Task link (Task / 課題 / 問題)
  let taskId: string | null = null;
  let problemTitle = '';

  const taskRow = rows.get('task') || rows.get('課題') || rows.get('problem');
  if (taskRow) {
    const taskLink = taskRow.cell.querySelector ? taskRow.cell.querySelector('a[href*="/tasks/"], a') : null;
    if (taskLink) {
      const href = (taskLink.getAttribute ? taskLink.getAttribute('href') : taskLink.href) ?? '';
      const parsedTask = parseTaskUrl(href);
      if (parsedTask) {
        taskId = parsedTask.taskId;
        contestId = contestId || parsedTask.contestId;
      }
      problemTitle = (taskLink.textContent ?? '').trim();
    } else {
      problemTitle = taskRow.text;
    }
  }

  // Fallback: search for any a[href*="/tasks/"] on page
  if (!taskId) {
    const taskLink = root.querySelector ? root.querySelector('a[href*="/tasks/"]') : null;
    if (taskLink) {
      const href = (taskLink.getAttribute ? taskLink.getAttribute('href') : taskLink.href) ?? '';
      const parsedTask = parseTaskUrl(href);
      if (parsedTask) {
        taskId = parsedTask.taskId;
        contestId = contestId || parsedTask.contestId;
      }
      if (!problemTitle) {
        problemTitle = (taskLink.textContent ?? '').trim();
      }
    }
  }

  if (!submissionId || !contestId || !taskId) {
    return null;
  }

  if (!problemTitle) {
    problemTitle = `Problem ${taskId}`;
  }

  // 4. Author (User / ユーザ)
  let author: string | null = null;
  const userRow = rows.get('user') || rows.get('ユーザ') || rows.get('author');
  if (userRow) {
    const userLink = userRow.cell.querySelector ? userRow.cell.querySelector('a[href*="/users/"], a') : null;
    if (userLink) {
      const href = (userLink.getAttribute ? userLink.getAttribute('href') : userLink.href) ?? '';
      const match = href.match(/\/users\/([a-zA-Z0-9_.-]+)/);
      author = match ? match[1] : (userLink.textContent ?? '').trim();
    } else {
      author = userRow.text;
    }
  }

  // 5. Logged-in Username (from header/navbar)
  // Look specifically outside the table for header/nav user
  let username: string | null = null;
  const headerElem = root.querySelector ? root.querySelector('#header, header, nav, #navbar-collapse') : null;
  if (headerElem) {
    username = extractUsername(headerElem);
  }
  if (!username) {
    // If no isolated header container, search root while excluding table if possible
    username = extractUsername(root);
  }

  // isOwner: author === logged-in username
  const isOwner = Boolean(author && username && author.toLowerCase() === username.toLowerCase());

  // 6. Verdict & Status (Status / 結果 / Result)
  let rawVerdict = '';
  let badgeClass = '';
  const statusRow = rows.get('status') || rows.get('結果') || rows.get('result') || rows.get('verdict');
  if (statusRow) {
    rawVerdict = statusRow.text;
    const badge = statusRow.cell.querySelector ? statusRow.cell.querySelector('.label, .badge, span') : null;
    if (badge) {
      badgeClass = (badge.getAttribute ? badge.getAttribute('class') : badge.className) ?? '';
      if (!rawVerdict) rawVerdict = (badge.textContent ?? '').trim();
    }
  }

  const isAccepted = isAcceptedVerdict(rawVerdict, badgeClass);

  // 7. Score (Score / 得点)
  let score: string | null = null;
  const scoreRow = rows.get('score') || rows.get('得点');
  if (scoreRow) {
    score = scoreRow.text;
  }

  // 8. Language (Language / 言語)
  let rawLang = '';
  const langRow = rows.get('language') || rows.get('言語') || rows.get('compiler');
  if (langRow) {
    rawLang = langRow.text;
  }
  const normLang = normalizeLanguage(rawLang);

  // 9. Submission Date & Timestamp (Submission Date / 提出日時 / Date)
  let submittedAt: string | null = null;
  let timestamp: number | null = null;
  const dateRow = rows.get('submission date') || rows.get('提出日時') || rows.get('date') || rows.get('time');
  if (dateRow) {
    submittedAt = dateRow.text;
    const timeElem = dateRow.cell.querySelector ? dateRow.cell.querySelector('time') : null;
    const timeText = timeElem ? (timeElem.textContent ?? '').trim() : submittedAt;
    timestamp = parseSubmissionTimestamp(timeText);
  }

  // 10. Source Code
  const codePre = root.querySelector ? root.querySelector('#submission-code, pre.prettyprint, pre') : null;
  const code = extractSourceCode(codePre);

  return {
    submissionId,
    contestId,
    taskId,
    problemTitle,
    author,
    username,
    isOwner,
    verdict: rawVerdict || (isAccepted ? 'AC' : 'UNKNOWN'),
    isAccepted,
    score,
    language: normLang.name,
    submittedAt,
    timestamp,
    code,
  };
}

/**
 * Returns true if the pathname represents an AtCoder submission detail page.
 * Path pattern: `/contests/:contestId/submissions/:submissionId`
 */
export function isSubmissionResultPage(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return /^\/contests\/[a-zA-Z0-9_.-]+\/submissions\/\d+\/?$/i.test(pathname.trim());
}

/**
 * Converts parsed AtCoder submission page data into a normalized CodeSync Submission payload.
 */
export function submissionFromPageData(
  data: AtCoderSubmissionPageData,
  origin = 'https://atcoder.jp',
): Submission {
  return {
    platform: 'atcoder',
    submissionId: data.submissionId,
    problemId: data.taskId,
    problemTitle: data.problemTitle,
    contest: data.contestId,
    language: data.language,
    sourceCode: data.code,
    verdict: 'accepted',
    submittedAt: data.submittedAt ?? new Date().toISOString(),
    problemUrl: `${origin}/contests/${data.contestId}/tasks/${data.taskId}`,
  };
}

export interface ProcessSubmissionPageOptions {
  url?: string;
  origin?: string;
  observed: Set<string>;
  queueFn: (submission: Submission) => Promise<{ queued?: boolean; reason?: string } | undefined>;
}

export interface ProcessSubmissionPageOutcome {
  status: 'queued' | 'skipped' | 'pending' | 'duplicate' | 'rejected' | 'not_owner';
  submission?: Submission;
}

/**
 * Complete pipeline for processing an AtCoder submission detail page:
 *   1. Parses page metadata, verdict, owner status, and source code.
 *   2. Deduplicates via `observed` set (`atcoder:<submissionId>`).
 *   3. If judging is in-progress (WJ, WR, Judging, [0/30]), leaves `observed` unflagged to allow subsequent scans.
 *   4. If not owned by the logged-in user, marks observed and skips queue.
 *   5. If not accepted (WA, TLE, etc.), marks observed and skips queue.
 *   6. When accepted AND owned: marks observed, constructs Submission, and queues.
 */
export async function processSubmissionPage(
  root: any,
  options: ProcessSubmissionPageOptions,
): Promise<ProcessSubmissionPageOutcome> {
  const url = options.url || (root.location?.href ?? '');
  const data = parseSubmissionPage(root, { url });
  if (!data) {
    return { status: 'skipped' };
  }

  const key = `atcoder:${data.submissionId}`;

  // 1. Prevent duplicate processing if already observed in this session
  if (options.observed.has(key)) {
    return { status: 'duplicate' };
  }

  // 2. If judging is still in-progress (WJ / WR / Judging / fractions), do NOT mark observed; wait for next transition
  const normVerdict = data.verdict.toLowerCase();
  const isJudgingInProgress = normVerdict.includes('wj') ||
    normVerdict.includes('wr') ||
    normVerdict.includes('judging') ||
    normVerdict.includes('waiting') ||
    /\d+\/\d+/.test(normVerdict);

  if (isJudgingInProgress) {
    return { status: 'pending' };
  }

  // 3. Must be owner (author === logged-in user)
  if (!data.isOwner) {
    options.observed.add(key);
    return { status: 'not_owner' };
  }

  // 4. Must be accepted (AC)
  if (!data.isAccepted) {
    options.observed.add(key);
    return { status: 'rejected' };
  }

  // 5. Accepted & Owned: mark observed immediately to prevent concurrent in-flight duplication
  options.observed.add(key);

  const origin = options.origin || 'https://atcoder.jp';
  const submission = submissionFromPageData(data, origin);

  try {
    const response = await options.queueFn(submission);
    if (
      !response?.queued &&
      response?.reason !== 'Already committed to GitHub.' &&
      response?.reason !== 'Already queued for GitHub.'
    ) {
      options.observed.delete(key);
    }
    return { status: 'queued', submission };
  } catch (err) {
    options.observed.delete(key);
    throw err;
  }
}
