// Pure parsing helpers for the CSES content script.
// No browser globals required — safe to import in tests and content scripts alike.

import type { Submission } from '../lib/types';

export interface CsesResultUrlInfo {
  submissionId: string;
}

export interface CsesTaskUrlInfo {
  problemId: string;
}

export interface CsesResultPageData {
  submissionId: string;
  problemId: string;
  problemTitle: string;
  username: string | null;
  verdict: string;
  score: string | null;
  isAccepted: boolean;
  language: string;
  submittedAt: string | null;
  timestamp: number | null;
  code: string;
  topic?: string;
}

export const DEFAULT_CSES_TOPIC = 'Uncategorized';
export const CSES_TOPIC_STORAGE_KEY = 'csesTopicCache';

// In-memory cache for fast synchronous lookups within the execution context
const topicMemoryCache = new Map<string, string>();

/**
 * Extracts submission ID from a CSES result URL.
 * Matches:
 *   - https://cses.fi/problemset/result/3889109/
 *   - https://cses.fi/problemset/result/3889109
 *   - /problemset/result/3889109/
 *   - /problemset/result/3889109
 *   - /course/result/3889109
 */
export function parseResultUrl(rawUrl: string | null | undefined): CsesResultUrlInfo | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  const match = trimmed.match(/(?:^|\/)result\/(\d+)\/?(?:[?#].*)?$/i);
  if (!match || !match[1]) return null;
  return { submissionId: match[1] };
}

/**
 * Extracts problem ID from a CSES task URL.
 * Matches:
 *   - https://cses.fi/problemset/task/1068/
 *   - https://cses.fi/problemset/task/1068
 *   - /problemset/task/1068/
 *   - /problemset/task/1068
 *   - /course/task/1068
 */
export function parseTaskUrl(rawUrl: string | null | undefined): CsesTaskUrlInfo | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  const match = trimmed.match(/(?:^|\/)task\/(\d+)\/?(?:[?#].*)?$/i);
  if (!match || !match[1]) return null;
  return { problemId: match[1] };
}

/** Accepted verdict strings and CSS classes used on CSES. */
const ACCEPTED_VERDICT_STRINGS = new Set([
  'accepted',
  'ac',
  'full',
]);

/** Returns true if a score string indicates a full score (100% / 100 pts). */
function isFullScore(score: string): boolean {
  const normScore = score.trim().toLowerCase();
  if (/^100\s*(pts|points)?$/i.test(normScore)) return true;
  if (/^100\s*\/\s*100$/i.test(normScore)) return true;
  return false;
}

/**
 * Returns true when a CSES verdict or score string indicates an Accepted / 100% submission.
 * IMPORTANT: "READY" alone indicates that test evaluation has completed, NOT that
 * the submission was accepted. "READY" is only accepted if accompanied by a 100% score.
 */
export function isAcceptedVerdict(
  verdict: string | null | undefined,
  score?: string | null | undefined,
): boolean {
  if (verdict) {
    const norm = verdict.trim().toLowerCase();

    // "READY" alone signifies test completion, NOT acceptance.
    if (norm === 'ready') {
      return score ? isFullScore(score) : false;
    }

    if (ACCEPTED_VERDICT_STRINGS.has(norm)) return true;

    // Check if class list or compound text indicates acceptance without failure markers
    const hasAcceptedMarker = /\b(?:accepted|ac|full)\b/i.test(norm);
    const hasFailureMarker = /\b(?:wrong|wa|tle|rte|mle|error|zero|partial|pending|testing|ready)\b/i.test(norm);

    if (hasAcceptedMarker && !hasFailureMarker) {
      return true;
    }
  }

  if (score) {
    return isFullScore(score);
  }

  return false;
}

/**
 * Parses a CSES submission timestamp string into a Unix epoch timestamp in milliseconds.
 * CSES formats timestamps as `YYYY-MM-DD HH:mm:ss` (e.g. "2026-10-02 17:53:32").
 * Also accepts standard ISO 8601 strings.
 * Timestamps on CSES are in UTC.
 */
export function parseTimestamp(rawDate: string | null | undefined): number | null {
  if (!rawDate) return null;
  const trimmed = rawDate.trim();
  if (!trimmed) return null;

  // YYYY-MM-DD HH:mm:ss with optional milliseconds and timezone
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[\sT](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/
  );

  if (match) {
    const [, y, m, d, hh, mm, ss, ms, tz] = match;
    const year = parseInt(y, 10);
    const month = parseInt(m, 10) - 1;
    const day = parseInt(d, 10);
    const hour = parseInt(hh, 10);
    const minute = parseInt(mm, 10);
    const second = parseInt(ss, 10);
    const millisecond = ms ? parseInt(ms.padEnd(3, '0').slice(0, 3), 10) : 0;

    if (tz) {
      const parsed = Date.parse(trimmed);
      return Number.isNaN(parsed) ? null : parsed;
    }

    const utcTime = Date.UTC(year, month, day, hour, minute, second, millisecond);
    return Number.isNaN(utcTime) ? null : utcTime;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Decodes standard HTML entities in source code strings.
 */
function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Extracts clean source code from CSES <pre> elements or markup.
 * CSES renders code in `<pre class="prettyprint linenums">` using Google Code Prettify:
 *   - May contain an `<ol class="linenums"><li class="L0">...</li></ol>` list
 *   - Or `<div class="linenums"><div>...</div></div>`
 *   - Or plain text inside `<pre>`
 * Extracts line-by-line without concatenating line number pseudo-elements or HTML tags,
 * unescapes HTML entities, and normalizes line breaks (\r\n -> \n).
 */
export function extractSourceCode(preElementOrHtml: any): string {
  if (!preElementOrHtml) return '';

  // If passed a DOM Element (or SimpleElement stub in tests)
  if (typeof preElementOrHtml === 'object') {
    // 1. Google Code Prettify <ol class="linenums"><li class="...">line</li></ol>
    const listItems = preElementOrHtml.querySelectorAll
      ? preElementOrHtml.querySelectorAll('li')
      : [];
    if (listItems.length > 0) {
      const joined = Array.from(listItems)
        .map((li: any) => li.textContent ?? '')
        .join('\n');
      return unescapeHtml(joined).replace(/\r\n/g, '\n');
    }

    // 2. Custom linenums container <div class="linenums"><div>line</div></div>
    const linenumsDiv = preElementOrHtml.querySelector
      ? preElementOrHtml.querySelector('.linenums')
      : null;
    if (linenumsDiv && linenumsDiv.children && linenumsDiv.children.length > 0) {
      const joined = Array.from(linenumsDiv.children)
        .map((child: any) => child.textContent ?? '')
        .join('\n');
      return unescapeHtml(joined).replace(/\r\n/g, '\n');
    }

    // 3. Plain text content inside <pre>
    const text = preElementOrHtml.textContent ?? '';
    return unescapeHtml(text).replace(/\r\n/g, '\n');
  }

  // If passed an HTML/text string
  if (typeof preElementOrHtml === 'string') {
    const raw = preElementOrHtml;

    // Check if it contains <li...> elements
    const liMatches = Array.from(raw.matchAll(/<li\b[^>]*>(.*?)<\/li>/gis));
    if (liMatches.length > 0) {
      return liMatches
        .map(m => unescapeHtml(m[1].replace(/<[^>]+>/g, '')))
        .join('\n')
        .replace(/\r\n/g, '\n');
    }

    // Check if it's wrapped in <pre...>...</pre>
    const preMatch = raw.match(/<pre\b[^>]*>(.*?)<\/pre>/is);
    const content = preMatch ? preMatch[1] : raw;

    // Strip HTML tags and unescape
    const stripped = content.replace(/<[^>]+>/g, '');
    return unescapeHtml(stripped).replace(/\r\n/g, '\n');
  }

  return '';
}

/**
 * Extracts the logged-in username from the CSES universal header.
 * Universal header: `<a class="account" href="/user/:userId">username</a>`.
 * When logged out: `<a class="account" href="/login">Login</a>`.
 */
export function extractUsername(root: any): string | null {
  if (!root) return null;
  const accountLink = root.querySelector
    ? root.querySelector('header .controls a.account, a.account, .account')
    : null;
  if (accountLink) {
    const text = (accountLink.textContent ?? '').trim();
    const href =
      (accountLink.getAttribute ? accountLink.getAttribute('href') : accountLink.href) ?? '';
    if (text.toLowerCase() === 'login' || href.includes('/login')) {
      return null;
    }
    if (text.length > 0) {
      return text;
    }
  }
  return null;
}

/**
 * Parses key-value pairs from a CSES summary table (`table.summary-table`).
 */
function extractSummaryRows(table: any): Map<string, { cell: any; text: string }> {
  const map = new Map<string, { cell: any; text: string }>();
  if (!table) return map;
  const rows = table.querySelectorAll ? table.querySelectorAll('tr') : [];
  for (const row of Array.from(rows)) {
    const cells = (row as any).querySelectorAll ? (row as any).querySelectorAll('td, th') : [];
    if (cells.length >= 2) {
      const key = (cells[0].textContent ?? '').trim().replace(/:$/, '').toLowerCase();
      const valText = (cells[1].textContent ?? '').trim();
      map.set(key, { cell: cells[1], text: valText });
    }
  }
  return map;
}

/**
 * Parses a CSES submission result page (`https://cses.fi/problemset/result/:id/`).
 * Extracts:
 *   - submissionId (from URL or DOM)
 *   - problemId & problemTitle
 *   - username (from header or table)
 *   - verdict & score
 *   - isAccepted (strict: "READY" alone is NOT accepted)
 *   - language
 *   - timestamp & submittedAt
 *   - code
 *   - topic (if sidebar heading is present)
 */
export function parseResultPage(
  root: any,
  options?: { url?: string },
): CsesResultPageData | null {
  if (!root) return null;

  // 1. Submission ID
  let submissionId: string | null = null;
  if (options?.url) {
    submissionId = parseResultUrl(options.url)?.submissionId ?? null;
  }
  if (!submissionId) {
    const docUrl = root.location?.href || root.baseURI || root.URL || null;
    if (docUrl) {
      submissionId = parseResultUrl(docUrl)?.submissionId ?? null;
    }
  }
  if (!submissionId) {
    const resultLink = root.querySelector
      ? root.querySelector('a.current[href*="/result/"], a[href*="/problemset/result/"]')
      : null;
    if (resultLink) {
      const href =
        (resultLink.getAttribute ? resultLink.getAttribute('href') : resultLink.href) ?? '';
      submissionId = parseResultUrl(href)?.submissionId ?? null;
    }
  }

  // 2. Summary table
  const summaryTable = root.querySelector ? root.querySelector('table.summary-table, table') : null;
  const rowMap = extractSummaryRows(summaryTable);

  // 3. Problem ID & Problem Title
  let problemId: string | null = null;
  let problemTitle: string | null = null;

  const taskRow = rowMap.get('task') || rowMap.get('problem');
  if (taskRow) {
    const taskLink = taskRow.cell.querySelector
      ? taskRow.cell.querySelector('a[href*="/task/"], a')
      : null;
    if (taskLink) {
      const href = (taskLink.getAttribute ? taskLink.getAttribute('href') : taskLink.href) ?? '';
      problemId = parseTaskUrl(href)?.problemId ?? null;
      problemTitle = (taskLink.textContent ?? '').trim();
    } else {
      problemTitle = taskRow.text;
    }
  }

  // Fallbacks for problem ID & title
  if (!problemId) {
    const fallbackLink = root.querySelector ? root.querySelector('a[href*="/task/"]') : null;
    if (fallbackLink) {
      const href =
        (fallbackLink.getAttribute ? fallbackLink.getAttribute('href') : fallbackLink.href) ?? '';
      problemId = parseTaskUrl(href)?.problemId ?? null;
      if (!problemTitle) {
        problemTitle = (fallbackLink.textContent ?? '').trim();
      }
    }
  }
  if (!problemTitle) {
    const h1 = root.querySelector ? root.querySelector('.title-block h1, h1') : null;
    if (h1) {
      problemTitle = (h1.textContent ?? '').trim();
    }
  }

  // Must have both submissionId and problemId
  if (!submissionId || !problemId) {
    return null;
  }

  // 4. Username
  let username = extractUsername(root);
  if (!username) {
    const senderRow = rowMap.get('sender') || rowMap.get('user');
    if (senderRow) {
      const userLink = senderRow.cell.querySelector ? senderRow.cell.querySelector('a') : null;
      username = userLink ? (userLink.textContent ?? '').trim() : senderRow.text;
    }
  }

  // 5. Verdict and Score
  const resultRow = rowMap.get('result');
  const scoreRow = rowMap.get('score');
  const statusRow = rowMap.get('status');

  const verdictText = resultRow ? resultRow.text : (statusRow ? statusRow.text : '');
  let verdictClass = '';
  if (resultRow?.cell) {
    const verdictSpan = resultRow.cell.querySelector
      ? resultRow.cell.querySelector('.verdict')
      : null;
    if (verdictSpan) {
      verdictClass =
        (verdictSpan.getAttribute ? verdictSpan.getAttribute('class') : verdictSpan.className) ?? '';
    }
  }

  const scoreText = scoreRow ? scoreRow.text : null;
  const isAccepted =
    isAcceptedVerdict(verdictText, scoreText) || isAcceptedVerdict(verdictClass, scoreText);

  // 6. Language
  const compilerRow = rowMap.get('compiler') || rowMap.get('language');
  const language = compilerRow ? compilerRow.text : 'Unknown';

  // 7. Time & Timestamp
  const timeRow = rowMap.get('time') || rowMap.get('date');
  const submittedAt = timeRow ? timeRow.text : null;
  const timestamp = parseTimestamp(submittedAt);

  // 8. Source code
  const preEl = root.querySelector ? root.querySelector('pre.prettyprint, pre') : null;
  const code = extractSourceCode(preEl);

  // 9. Topic/category from sidebar if available
  let topic: string | undefined;
  const sidebarHeading = root.querySelector
    ? root.querySelector('.nav.sidebar h4, .sidebar h4, h4')
    : null;
  if (sidebarHeading) {
    const headingText = (sidebarHeading.textContent ?? '').trim();
    if (headingText && headingText.toLowerCase() !== 'your submissions') {
      topic = headingText;
    }
  }

  return {
    submissionId,
    problemId,
    problemTitle: problemTitle || `Problem ${problemId}`,
    username,
    verdict: verdictText || (isAccepted ? 'ACCEPTED' : 'UNKNOWN'),
    score: scoreText,
    isAccepted,
    language,
    submittedAt,
    timestamp,
    code,
    ...(topic ? { topic } : {}),
  };
}

// ── Topic / Category Resolution and Caching ──────────────────────────────────

/**
 * Returns the currently in-memory cached topic for a problem, or null.
 */
export function getCachedTopic(problemId: string | null | undefined): string | null {
  if (!problemId) return null;
  return topicMemoryCache.get(String(problemId).trim()) ?? null;
}

/**
 * Clears the in-memory topic cache (primarily for tests).
 */
export function clearTopicCache(): void {
  topicMemoryCache.clear();
}

/**
 * Saves a map of problemId -> category into the memory cache and chrome.storage.local.
 */
export async function saveTopicsToCache(topics: Record<string, string>): Promise<void> {
  for (const [id, topic] of Object.entries(topics)) {
    if (id && topic) {
      topicMemoryCache.set(String(id).trim(), topic.trim());
    }
  }

  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(CSES_TOPIC_STORAGE_KEY);
      const existing =
        (stored[CSES_TOPIC_STORAGE_KEY] as Record<string, string> | undefined) ?? {};
      const updated = { ...existing, ...topics };
      await chrome.storage.local.set({ [CSES_TOPIC_STORAGE_KEY]: updated });
    }
  } catch {
    // Fail-safe: ignore storage errors
  }
}

/**
 * Loads cached topics from chrome.storage.local into the memory cache.
 */
export async function loadTopicsFromStorage(): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(CSES_TOPIC_STORAGE_KEY);
      const cache = stored[CSES_TOPIC_STORAGE_KEY] as Record<string, string> | undefined;
      if (cache && typeof cache === 'object') {
        for (const [id, topic] of Object.entries(cache)) {
          if (id && topic) {
            topicMemoryCache.set(String(id).trim(), topic.trim());
          }
        }
      }
    }
  } catch {
    // Fail-safe: ignore storage errors
  }
}

/**
 * Parses problem categories from CSES HTML or DOM.
 * Supports:
 *   1. Problemset index page (/problemset/ or /problemset/list) with `<h2>Category</h2>` followed by task lists.
 *   2. Task page sidebar (.nav.sidebar) with `<h4>Category</h4>` followed by problem links.
 * Returns a mapping of problemId -> category string.
 */
export function parseProblemsetCategories(rootOrHtml: any): Record<string, string> {
  const result: Record<string, string> = {};
  if (!rootOrHtml) return result;

  // Branch A: DOM Element / Document
  if (typeof rootOrHtml === 'object') {
    const headings = rootOrHtml.querySelectorAll
      ? rootOrHtml.querySelectorAll('h2, .nav.sidebar h4, h4')
      : [];

    for (const heading of Array.from(headings)) {
      const categoryName = (heading as any).textContent?.trim() ?? '';
      if (
        !categoryName ||
        categoryName.toLowerCase() === 'general' ||
        categoryName.toLowerCase() === 'your submissions'
      ) {
        continue;
      }

      // Check following siblings until next heading
      let nextElem = (heading as any).nextElementSibling;
      while (nextElem && !['H2', 'H4'].includes(nextElem.tagName)) {
        const taskLinks = nextElem.querySelectorAll
          ? nextElem.querySelectorAll('a[href*="/task/"]')
          : [];
        for (const link of Array.from(taskLinks)) {
          const href =
            (link as any).getAttribute ? (link as any).getAttribute('href') : (link as any).href;
          const taskInfo = parseTaskUrl(href);
          if (taskInfo?.problemId) {
            result[taskInfo.problemId] = categoryName;
          }
        }

        if (nextElem.tagName === 'A') {
          const href = nextElem.getAttribute ? nextElem.getAttribute('href') : nextElem.href;
          const taskInfo = parseTaskUrl(href);
          if (taskInfo?.problemId) {
            result[taskInfo.problemId] = categoryName;
          }
        }
        nextElem = nextElem.nextElementSibling;
      }
    }

    // Fallback: If headings had sibling task-lists not matched above
    if (Object.keys(result).length === 0) {
      const taskLists = rootOrHtml.querySelectorAll ? rootOrHtml.querySelectorAll('.task-list') : [];
      for (const list of Array.from(taskLists)) {
        let prev = (list as any).previousElementSibling;
        let categoryName = '';
        while (prev) {
          if (['H2', 'H3', 'H4'].includes(prev.tagName)) {
            categoryName = prev.textContent?.trim() ?? '';
            break;
          }
          prev = prev.previousElementSibling;
        }
        if (categoryName && categoryName.toLowerCase() !== 'general') {
          const links =
            (list as any).querySelectorAll ? (list as any).querySelectorAll('a[href*="/task/"]') : [];
          for (const link of Array.from(links)) {
            const el = link as any;
            const href = el.getAttribute ? el.getAttribute('href') : el.href;
            const taskInfo = parseTaskUrl(href);
            if (taskInfo?.problemId) {
              result[taskInfo.problemId] = categoryName;
            }
          }
        }
      }
    }

    return result;
  }

  // Branch B: HTML String
  if (typeof rootOrHtml === 'string') {
    const html = rootOrHtml;
    const sectionRe = /<h[24]\b[^>]*>(.*?)<\/h[24]>(.*?)(?=<h[24]\b|$)/gis;
    let match;
    while ((match = sectionRe.exec(html)) !== null) {
      const rawCategory = match[1].replace(/<[^>]+>/g, '').trim();
      if (
        !rawCategory ||
        rawCategory.toLowerCase() === 'general' ||
        rawCategory.toLowerCase() === 'your submissions'
      ) {
        continue;
      }
      const sectionBody = match[2];
      const linkRe = /href=["'][^"']*\/task\/(\d+)\/?["']/gi;
      let lMatch;
      while ((lMatch = linkRe.exec(sectionBody)) !== null) {
        const pId = lMatch[1];
        if (pId) {
          result[pId] = rawCategory;
        }
      }
    }
  }

  return result;
}

export interface ResolveTopicOptions {
  fetchFn?: typeof fetch;
  origin?: string;
  problemsetDoc?: any;
}

/**
 * Resolves the topic/category for a CSES problem ID.
 * Multi-tier resolution:
 *   1. In-memory cache
 *   2. chrome.storage.local cache
 *   3. In-memory DOM document (if provided via options.problemsetDoc)
 *   4. Network fetch from https://cses.fi/problemset/list (via fetchFn)
 *   5. Fallback: fails safely to DEFAULT_CSES_TOPIC ("Uncategorized")
 */
export async function resolveProblemTopic(
  problemId: string | null | undefined,
  options?: ResolveTopicOptions,
): Promise<string> {
  if (!problemId) return DEFAULT_CSES_TOPIC;
  const pId = String(problemId).trim();
  if (!pId) return DEFAULT_CSES_TOPIC;

  // 1. Check in-memory cache
  const cached = getCachedTopic(pId);
  if (cached) return cached;

  // 2. Check storage cache
  await loadTopicsFromStorage();
  const fromStorage = getCachedTopic(pId);
  if (fromStorage) return fromStorage;

  // 3. Resolve from provided problemsetDoc if available
  if (options?.problemsetDoc) {
    try {
      const parsed = parseProblemsetCategories(options.problemsetDoc);
      if (Object.keys(parsed).length > 0) {
        await saveTopicsToCache(parsed);
        const resolved = getCachedTopic(pId);
        if (resolved) return resolved;
      }
    } catch {
      // Ignore parsing errors and continue to fallback
    }
  }

  // 4. Resolve via network fetch if fetchFn is available
  const fetcher = options?.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : null);
  if (fetcher) {
    try {
      const origin = options?.origin ?? 'https://cses.fi';
      const response = await fetcher(`${origin}/problemset/list`);
      if (response && response.ok) {
        const text = await response.text();
        const parsed = parseProblemsetCategories(text);
        if (Object.keys(parsed).length > 0) {
          await saveTopicsToCache(parsed);
          const resolved = getCachedTopic(pId);
          if (resolved) return resolved;
        }
      }
    } catch {
      // Network or fetch error: fail safely
    }
  }

  // 5. Fail safely to Uncategorized
  return DEFAULT_CSES_TOPIC;
}

/**
 * Returns true if the pathname corresponds to a CSES submission result page.
 * Matches:
 *   - /problemset/result/3889109/
 *   - /problemset/result/3889109
 *   - /course/result/3889109
 */
export function isResultPage(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return /(?:^|\/)result\/\d+\/?$/i.test(pathname.trim());
}

/**
 * Constructs a normalized CodeSync Submission object from parsed CSES result data.
 */
export function submissionFromResultData(
  data: CsesResultPageData,
  origin: string = 'https://cses.fi',
  topic?: string,
): Submission {
  const resolvedTopic = topic ?? data.topic ?? DEFAULT_CSES_TOPIC;
  return {
    platform: 'cses',
    submissionId: data.submissionId,
    problemId: data.problemId,
    problemTitle: data.problemTitle,
    language: data.language,
    sourceCode: data.code,
    verdict: 'accepted',
    submittedAt: data.submittedAt ?? new Date().toISOString(),
    problemUrl: `${origin}/problemset/task/${data.problemId}`,
    topic: resolvedTopic,
  };
}

export interface ProcessResultPageOptions {
  url?: string;
  origin?: string;
  observed: Set<string>;
  queueFn: (submission: Submission) => Promise<{ queued?: boolean; reason?: string } | undefined>;
  resolveTopicFn?: (problemId: string) => Promise<string>;
}

export interface ProcessResultPageOutcome {
  status: 'queued' | 'skipped' | 'pending' | 'duplicate' | 'rejected';
  submission?: Submission;
}

/**
 * Complete pipeline for processing a CSES result page:
 *   1. Parses page metadata, verdict, and source code.
 *   2. Prevents duplicate processing via `observed` set.
 *   3. If testing is in-progress (TESTING / PENDING), leaves `observed` unflagged to allow subsequent scans.
 *   4. If tests finished but verdict is rejected, flags `observed` and skips queue.
 *   5. If accepted: resolves topic, constructs Submission payload, and sends to CodeSync queue.
 */
export async function processResultPage(
  root: any,
  options: ProcessResultPageOptions,
): Promise<ProcessResultPageOutcome> {
  const url = options.url || (root.location?.href ?? '');
  const data = parseResultPage(root, { url });
  if (!data) {
    return { status: 'skipped' };
  }

  // 1. Prevent duplicate processing if already observed in this session
  if (options.observed.has(data.submissionId)) {
    return { status: 'duplicate' };
  }

  // 2. If testing is still in progress, do NOT mark observed; wait for next transition
  const normVerdict = data.verdict.toLowerCase();
  const isTestingInProgress = normVerdict.includes('testing') || normVerdict.includes('pending');
  if (isTestingInProgress) {
    return { status: 'pending' };
  }

  // 3. If tests are finished but the verdict is NOT accepted, mark observed to prevent redundant rescanning
  if (!data.isAccepted) {
    options.observed.add(data.submissionId);
    return { status: 'rejected' };
  }

  // 4. Accepted submission: mark observed immediately to prevent concurrent in-flight duplication
  options.observed.add(data.submissionId);

  // 5. Resolve topic (use topic on result page if present, else resolveTopicFn)
  let topic = data.topic;
  if (!topic || topic === DEFAULT_CSES_TOPIC) {
    if (options.resolveTopicFn) {
      topic = await options.resolveTopicFn(data.problemId);
    } else {
      topic = await resolveProblemTopic(data.problemId, { origin: options.origin });
    }
  }

  const origin = options.origin || 'https://cses.fi';
  const submission = submissionFromResultData(data, origin, topic);

  try {
    const response = await options.queueFn(submission);
    // If rejected for an unexpected reason (not already queued/committed), allow retry
    if (
      !response?.queued &&
      response?.reason !== 'Already committed to GitHub.' &&
      response?.reason !== 'Already queued for GitHub.'
    ) {
      options.observed.delete(data.submissionId);
    }
    return { status: 'queued', submission };
  } catch (err) {
    // If queue dispatch threw, remove from observed so next mutation/scan can retry
    options.observed.delete(data.submissionId);
    throw err;
  }
}

