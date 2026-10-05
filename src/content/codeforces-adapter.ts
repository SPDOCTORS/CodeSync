// Pure parsing helpers for the Codeforces content script.
// No browser globals — safe to import in tests and the content script alike.

import type { Submission } from '../lib/types';

/** Accepted verdict text as rendered by Codeforces. */
const ACCEPTED_VERDICTS = new Set(['accepted', 'ok']);

/**
 * Extracts the numeric submission ID from a Codeforces submissions-table row.
 * Codeforces renders submission IDs inside hrefs of the form:
 *   /contest/<id>/submission/<submissionId>
 *   /problemset/submission/<handle>/<submissionId>
 * The href is more reliable than the link text content, which may be truncated.
 */
export function submissionIdFromRow(row: Element): string | null {
  const link = row.querySelector<HTMLAnchorElement>('a[href*="/submission/"]');
  if (!link) return null;
  // Matches both /contest/<id>/submission/<subId> and /problemset/submission/<handle>/<subId>
  const match = link.href.match(/\/submission\/[^/]*\/(\d+)\/?$|\/submission\/(\d+)\/?$/);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/**
 * Returns true when a Codeforces submission row shows an Accepted verdict.
 * - Modern pages: <span class="verdict-accepted"> or <td class="verdict-accepted">
 * - Older contest/gym pages: text content "Accepted" or "OK" inside a verdict cell
 */
export function isAcceptedRow(row: Element): boolean {
  if (row.querySelector('.verdict-accepted')) return true;
  const verdictCell = row.querySelector<HTMLElement>('.status-verdict-cell, td.status-small');
  if (verdictCell) {
    const text = (verdictCell.textContent ?? '').trim().toLowerCase();
    if (ACCEPTED_VERDICTS.has(text)) return true;
  }
  return false;
}

/**
 * Scans a Codeforces submissions table element and returns all Accepted
 * submission IDs in document order (newest-first as rendered by Codeforces).
 * Checks `data-submission-id` first, falls back to href extraction.
 */
export function acceptedIdsFromTable(table: Element): string[] {
  const ids: string[] = [];

  // Modern Codeforces: rows carry data-submission-id attribute
  for (const row of Array.from(table.querySelectorAll<HTMLElement>('tr[data-submission-id], tr.highlighted'))) {
    if (!isAcceptedRow(row)) continue;
    const fromAttr = row.dataset['submissionId'];
    const id = (fromAttr && /^\d+$/.test(fromAttr)) ? fromAttr : submissionIdFromRow(row);
    if (id) ids.push(id);
  }

  // Older table layout (no data attribute): scan all tbody rows
  if (ids.length === 0) {
    for (const row of Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody tr'))) {
      if (!isAcceptedRow(row)) continue;
      const id = submissionIdFromRow(row);
      if (id) ids.push(id);
    }
  }

  return ids;
}

/**
 * Returns true when the current page pathname matches a known Codeforces
 * submissions-listing URL pattern.
 * Covers: /contest/<id>/my, /gym/<id>/my, /problemset/status, /problemset/status/<handle>,
 *         /submissions/<handle>, /profile/<handle>
 */
export function isSubmissionsPage(pathname: string): boolean {
  const clean = pathname.split('?')[0].split('#')[0];
  return (
    /\/contest\/\d+\/my(\/|$)/.test(clean) ||
    /\/gym\/\d+\/my(\/|$)/.test(clean) ||
    /\/problemset\/status(\/|$)/.test(clean) ||
    /\/submissions\//.test(clean) ||
    /\/profile\//.test(clean)
  );
}

// ── Phase 3: source extraction and row metadata ───────────────────────────────

/** All submission metadata extractable from a Codeforces table row. */
export interface CodeforcesRowData {
  submissionId: string;
  /** Full URL of the submission detail page — used to fetch source code. */
  submissionUrl: string;
  contestId: string | null;
  /** e.g. "1999A" for contest problems, or raw submissionId as fallback. */
  problemId: string;
  problemTitle: string;
  problemUrl: string;
  language: string;
  submittedAt: string; // ISO 8601
}

/** Decodes HTML character entities produced by Codeforces source code blocks. */
export function htmlDecode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_: string, code: string) => String.fromCharCode(Number(code)));
}

/**
 * Extracts source code from the HTML text of a Codeforces submission detail page.
 * Primary:  <pre id="program-source-text">…</pre>  (modern Codeforces)
 * Fallback: first <pre class="prettyprint">…</pre>  (older page variant)
 * Returns null when no recognisable source block is found.
 */
export function sourceCodeFromHtml(html: string): string | null {
  const byId = html.match(/<pre[^>]+id="program-source-text"[^>]*>([\s\S]*?)<\/pre>/i);
  if (byId?.[1] != null) {
    const decoded = htmlDecode(byId[1]).trim();
    return decoded || null;
  }
  const pretty = html.match(/<pre[^>]+class="[^"]*prettyprint[^"]*"[^>]*>([\s\S]*?)<\/pre>/i);
  if (pretty?.[1] != null) {
    const decoded = htmlDecode(pretty[1]).trim();
    return decoded || null;
  }
  return null;
}

/**
 * Extracts Codeforces CSRF token from the DOM document or an HTML string.
 * Codeforces embeds the token in:
 *   1. <meta name="X-Csrf-Token" content="...">
 *   2. <span class="csrf-token" data-csrf="...">
 *   3. <input type="hidden" name="csrf_token" value="...">
 */
export function extractCsrfToken(docOrHtml: Document | Element | string | null | undefined): string | null {
  if (!docOrHtml) return null;

  if (typeof docOrHtml === 'string') {
    const metaMatch =
      docOrHtml.match(/<meta[^>]+name=["']X-Csrf-Token["'][^>]+content=["']([a-f0-9]{32,})["']/i) ||
      docOrHtml.match(/<meta[^>]+content=["']([a-f0-9]{32,})["'][^>]+name=["']X-Csrf-Token["']/i);
    if (metaMatch?.[1]) return metaMatch[1];

    const spanMatch =
      docOrHtml.match(/<span[^>]+class=["'][^"']*csrf-token[^"']*["'][^>]+data-csrf=["']([a-f0-9]{32,})["']/i) ||
      docOrHtml.match(/<span[^>]+data-csrf=["']([a-f0-9]{32,})["'][^>]+class=["'][^"']*csrf-token[^"']*["']/i);
    if (spanMatch?.[1]) return spanMatch[1];

    const inputMatch =
      docOrHtml.match(/<input[^>]+name=["']csrf_token["'][^>]+value=["']([a-f0-9]{32,})["']/i) ||
      docOrHtml.match(/<input[^>]+value=["']([a-f0-9]{32,})["'][^>]+name=["']csrf_token["']/i);
    if (inputMatch?.[1]) return inputMatch[1];

    return null;
  }

  const meta = docOrHtml.querySelector?.('meta[name="X-Csrf-Token"]')?.getAttribute('content');
  if (meta && meta.trim().length >= 10) return meta.trim();

  const span = docOrHtml.querySelector?.('span.csrf-token')?.getAttribute('data-csrf');
  if (span && span.trim().length >= 10) return span.trim();

  const input = (docOrHtml.querySelector?.('input[name="csrf_token"]') as HTMLInputElement | null)?.value;
  if (input && input.trim().length >= 10) return input.trim();

  return null;
}

/**
 * Parses the JSON response from Codeforces /data/submitSource endpoint.
 * Returns the source code string if present and non-empty, or null otherwise.
 */
export function sourceCodeFromJson(payload: unknown): string | null {
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object') return null;

  const candidate = (payload as Record<string, unknown>)['source'];
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
}

export interface FetchSubmissionSourceOptions {
  origin?: string;
  csrfToken?: string | null;
  fetchFn?: typeof fetch;
}

/**
 * Retrieves the source code for a submission using Codeforces' supported same-session
 * mechanism (`POST /data/submitSource` with CSRF token and submissionId), falling back
 * to fetching the full submission page HTML if the primary endpoint is unavailable.
 */
export async function fetchSubmissionSource(
  submissionId: string,
  fallbackUrl?: string,
  options?: FetchSubmissionSourceOptions
): Promise<string | null> {
  const fetchFn = options?.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchFn) return null;

  const origin = options?.origin ?? (typeof window !== 'undefined' ? window.location.origin : 'https://codeforces.com');
  const csrf = options?.csrfToken ?? (typeof document !== 'undefined' ? extractCsrfToken(document) : null);

  // 1. Primary mechanism: Codeforces same-session view-source AJAX endpoint (/data/submitSource)
  try {
    const body = new URLSearchParams();
    body.append('submissionId', submissionId);
    if (csrf) {
      body.append('csrf_token', csrf);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (csrf) {
      headers['X-Csrf-Token'] = csrf;
    }

    const response = await fetchFn(`${origin}/data/submitSource`, {
      method: 'POST',
      headers,
      body: body.toString(),
      credentials: 'same-origin',
    });

    if (response.ok) {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        const source = sourceCodeFromJson(json);
        if (source) return source;
      } catch {
        const fromHtml = sourceCodeFromHtml(text);
        if (fromHtml) return fromHtml;
      }
    }
  } catch {
    // Ignore and proceed to fallback
  }

  // 2. Fallback: fetch the submission detail page directly
  if (fallbackUrl) {
    try {
      const response = await fetchFn(fallbackUrl, { credentials: 'same-origin' });
      if (response.ok) {
        const html = await response.text();
        const source = sourceCodeFromHtml(html);
        if (source) return source;
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Language name patterns produced by Codeforces in submission table cells.
 * Ordered from most-specific to least-specific to avoid false matches.
 * NOTE: pypy must appear before python so "PyPy 3" isn't misread as plain python.
 */
const LANGUAGE_RE =
  /^(gnu[\s+]c|c\+\+|pypy|python|java(?!script)|javascript|typescript|kotlin|rust|go\b|haskell|scala|ruby|swift|dart|pascal|delphi|mono c#|c#|php|perl|d\b|f#|ocaml|r\b|julia)/i;

/**
 * Extracts the programming language from a Codeforces submission table row.
 *
 * Strategy:
 *  1. Positional: find the problem-link cell, then use the immediately
 *     following cell as the language cell. This is robust to Codeforces
 *     wrapping language names inside filter-anchor tags
 *     (e.g. `<a href="?lang=54">PyPy 3-64</a>`), which the old
 *     `!querySelector('a')` guard incorrectly excluded.
 *  2. Regex fallback: scan all cells for a text matching LANGUAGE_RE
 *     without the anchor guard, covering pages where the column order
 *     differs or the problem link is absent.
 */
function extractLanguage(row: Element): string {
  const cells = Array.from(row.querySelectorAll('td'));

  // --- 1. Positional lookup ---
  const probIdx = cells.findIndex(c => !!c.querySelector('a[href*="/problem/"]'));
  if (probIdx !== -1 && probIdx + 1 < cells.length) {
    const langCell = cells[probIdx + 1];
    // Use textContent so anchor-wrapped text ("PyPy 3-64") is captured correctly.
    const text = ((langCell as HTMLElement).textContent ?? '').trim();
    // Reject obviously wrong neighbours (time "31 ms", verdict text, IDs).
    if (text && !/^\d+(\s*(ms|MB|KB|B))?$/i.test(text) && !ACCEPTED_VERDICTS.has(text.toLowerCase())) {
      return text;
    }
  }

  // --- 2. Regex fallback (no anchor guard) ---
  for (const cell of cells) {
    const text = ((cell as HTMLElement).textContent ?? '').trim();
    if (LANGUAGE_RE.test(text)) return text;
  }

  return 'Unknown';
}


/**
 * Parses a Codeforces display timestamp (e.g. "Sep/30/2024 17:30:45")
 * into an ISO 8601 string. Falls back to current time on parse failure.
 */
export function parseCodeforcesDate(raw: string): string {
  try {
    // "Sep/30/2024 17:30:45" → "Sep 30 2024 17:30:45" (Date-parseable)
    const normalised = raw.trim().replace(/\//g, ' ');
    const d = new Date(normalised);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch { /* fall through */ }
  return new Date().toISOString();
}

/** Extracts a submission timestamp from a row, returning ISO 8601. */
function extractTimestamp(row: Element): string {
  // Prefer a Unix timestamp stored in data-timestamp attribute
  const stamped = row.querySelector<HTMLElement>('span[data-timestamp], td[data-timestamp]');
  if (stamped?.dataset['timestamp']) {
    const ts = Number(stamped.dataset['timestamp']);
    if (!Number.isNaN(ts) && ts > 0) return new Date(ts * 1000).toISOString();
  }
  // Fall back to span.format-time text content (Codeforces i18n element)
  const fmt = row.querySelector<HTMLElement>('span.format-time');
  if (fmt?.textContent) return parseCodeforcesDate(fmt.textContent);
  return new Date().toISOString();
}

/**
 * Extracts all available submission metadata from a Codeforces table row.
 * Returns null when the row does not contain a recognisable submission link.
 *
 * @param row    - The <tr> element from a Codeforces submissions table.
 * @param origin - The page origin (e.g. "https://codeforces.com") used to
 *                 build absolute URLs from relative hrefs.
 */
export function rowDataFromElement(row: Element, origin: string): CodeforcesRowData | null {
  const submLink = row.querySelector<HTMLAnchorElement>('a[href*="/submission/"]');
  if (!submLink) return null;
  const submHref = submLink.getAttribute('href') ?? '';

  // Derive submission ID and contest ID from the href
  const contestMatch = submHref.match(/\/contest\/(\d+)\/submission\/(\d+)/);
  const gymMatch     = submHref.match(/\/gym\/(\d+)\/submission\/(\d+)/);
  const psMatch      = submHref.match(/\/problemset\/submission\/[^/]+\/(\d+)/);
  const fromAttr     = (row as HTMLElement).dataset?.['submissionId'];

  const submissionId =
    contestMatch?.[2] ??
    gymMatch?.[2] ??
    psMatch?.[1] ??
    (fromAttr && /^\d+$/.test(fromAttr) ? fromAttr : null);
  if (!submissionId) return null;

  // Problem link — href matches /contest/<id>/problem/<index> or /problemset/problem/<id>/<index>
  const probLink = row.querySelector<HTMLAnchorElement>('a[href*="/problem/"]');
  const probHref = probLink?.getAttribute('href') ?? '';
  const probUrl  = probHref ? (probHref.startsWith('http') ? probHref : `${origin}${probHref}`) : '';

  const cleanProbHref    = probHref.split('?')[0].split('#')[0];
  const psProbMatch      = cleanProbHref.match(/\/problemset\/problem\/(\d+)\/([A-Z0-9]+)\/?$/i);
  const contestProbMatch = cleanProbHref.match(/\/(?:contest|gym)\/(\d+)\/problem\/([A-Z0-9]+)\/?$/i);
  const simpleProbMatch  = cleanProbHref.match(/\/problem\/([A-Z0-9]+)\/?$/i);

  const problemContestId = psProbMatch?.[1] ?? contestProbMatch?.[1] ?? null;
  const problemIndex     = psProbMatch?.[2] ?? contestProbMatch?.[2] ?? simpleProbMatch?.[1] ?? '';

  const contestId = contestMatch?.[1] ?? gymMatch?.[1] ?? problemContestId ?? null;
  const submissionUrl = submHref.startsWith('http') ? submHref : `${origin}${submHref}`;
  const problemId    = contestId && problemIndex ? `${contestId}${problemIndex}` : submissionId;

  // Strip leading "A - " / "A. " / "4A - " / "C – " style index prefixes from problem link text
  const rawTitle    = (probLink?.textContent ?? '').trim();
  const problemTitle = rawTitle.replace(/^(?:\d+[A-Z0-9]*|[A-Z]\d*)(\s*[.\u2013]\s*|\s+-\s+)/i, '').trim() || rawTitle || `Submission ${submissionId}`;

  const language    = extractLanguage(row);
  const submittedAt = extractTimestamp(row);

  return { submissionId, submissionUrl, contestId, problemId, problemTitle, problemUrl: probUrl, language, submittedAt };
}

/**
 * Builds a complete Submission object from row metadata and fetched source code.
 * The verdict is always 'accepted' — this is only called after isAcceptedRow passes.
 * Note: problem rating is not available from the submissions table; files are
 * placed in Codeforces/Unrated/ until Phase 4 adds rating lookup.
 */
export function submissionFromRowData(data: CodeforcesRowData, sourceCode: string, rating?: number): Submission {
  return {
    platform: 'codeforces',
    submissionId: data.submissionId,
    problemId: data.problemId,
    problemTitle: data.problemTitle,
    language: data.language,
    sourceCode,
    verdict: 'accepted',
    submittedAt: data.submittedAt,
    problemUrl: data.problemUrl || 'https://codeforces.com',
    contest: data.contestId ?? undefined,
    rating,
  };
}
