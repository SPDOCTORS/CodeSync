// Pure parsing helpers for the CodeChef content script.
// No browser globals — safe to import in tests and content scripts alike.

import type { Submission } from '../lib/types';

export interface CodeChefProblemInfo {
  contestId: string;
  problemCode: string;
}

export interface CodeChefRowData {
  submissionId: string;
  submissionUrl: string;
  contestId: string;
  problemId: string;
  problemTitle: string;
  problemUrl: string;
  language: string;
  submittedAt: string;
  isAccepted: boolean;
}

export interface CodeChefLanguageMetadata {
  shortName: string;
  fullName: string;
  extension: string;
  id?: string;
}

export interface CodeChefSubmissionSourceResult {
  code: string;
  language: CodeChefLanguageMetadata;
}

export interface FetchCodeChefSourceOptions {
  origin?: string;
  fetchFn?: typeof fetch;
}

/** Accepted verdict representations on CodeChef. */
const ACCEPTED_VERDICTS = new Set([
  'accepted',
  'correct answer',
  '100 pts',
  '100/100',
  '100 points',
  '100',
  'ac',
]);

/**
 * Returns true when a CodeChef verdict string represents an Accepted / full-score result.
 * Handles "Accepted", "Correct Answer", "100 pts", "100/100", "(100)", and case/spacing variations.
 */
export function isAcceptedVerdict(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase().replace(/^\(|\)$/g, '').trim();
  if (ACCEPTED_VERDICTS.has(normalized)) return true;
  if (/^100(\.0+)?\s*(pts|points)?$/i.test(normalized)) return true;
  if (/^100\s*\/\s*100$/i.test(normalized)) return true;
  return false;
}

/**
 * Returns true when a CodeChef Recent Activity row indicates an Accepted submission.
 * Checks for:
 *   1. Tick icon image (`tick-icon.gif` or alt `status icon`) without a cross icon.
 *   2. Verdict span title attribute (`title="accepted"`).
 *   3. Score cell title or text content matching full score / accepted verdict (`"(100)"`).
 */
export function isAcceptedRow(row: Element): boolean {
  // Explicit failure icons
  if (row.querySelector('img[src*="cross-icon"], img[src*="cross"]')) {
    return false;
  }

  // Explicit success icons
  if (row.querySelector('img[src*="tick-icon"], img[src*="tick"]')) {
    return true;
  }

  // Verdict span title attribute (e.g. <span title="accepted">)
  const spans = Array.from(row.querySelectorAll('span[title]'));
  for (const span of spans) {
    const title = span.getAttribute('title');
    if (isAcceptedVerdict(title)) return true;
    if (title && /wrong\s*answer|time\s*limit|runtime|compile/i.test(title)) return false;
  }

  // Score cell title or content (e.g. <td title="(100)">)
  const cells = Array.from(row.querySelectorAll('td'));
  if (cells.length >= 3) {
    const resultCell = cells[2];
    const cellTitle = resultCell.getAttribute('title');
    if (isAcceptedVerdict(cellTitle)) return true;
    const text = resultCell.textContent?.trim();
    if (isAcceptedVerdict(text)) return true;
  }

  return false;
}

/**
 * Parses problem and contest information from a CodeChef problem URL or pathname.
 * Supports:
 *   1. Practice problems: /problems/<problemCode>
 *   2. Practice course problems: /practice/course/.../problems/<problemCode>
 *   3. Contest problems: /<contestId>/problems/<problemCode> or /contest/<contestId>/problems/<problemCode>
 */
export function parseProblemUrl(urlOrPath: string): CodeChefProblemInfo | null {
  if (!urlOrPath) return null;

  let pathname = urlOrPath;
  try {
    if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
      pathname = new URL(urlOrPath).pathname;
    }
  } catch {
    // Treat as raw path if URL constructor fails
  }

  // Strip query string, hash, and trailing slashes
  const cleanPath = pathname.split('?')[0].split('#')[0].replace(/\/+$/, '');

  // 1. Practice course: /practice/course/.../problems/<problemCode>
  const practiceCourseMatch = cleanPath.match(/\/practice\/course\/.*\/problems\/([A-Za-z0-9_]+)$/i);
  if (practiceCourseMatch?.[1]) {
    return {
      contestId: 'Practice',
      problemCode: practiceCourseMatch[1],
    };
  }

  // 2. Practice problem: /problems/<problemCode>
  const practiceMatch = cleanPath.match(/^\/problems\/([A-Za-z0-9_]+)$/i);
  if (practiceMatch?.[1]) {
    return {
      contestId: 'Practice',
      problemCode: practiceMatch[1],
    };
  }

  // 3. Contest problem: /contest/<contestId>/problems/<problemCode>
  const explicitContestMatch = cleanPath.match(/^\/contest\/([A-Za-z0-9_]+)\/problems\/([A-Za-z0-9_]+)$/i);
  if (explicitContestMatch?.[1] && explicitContestMatch?.[2]) {
    return {
      contestId: explicitContestMatch[1],
      problemCode: explicitContestMatch[2],
    };
  }

  // 4. Contest problem: /<contestId>/problems/<problemCode> (e.g. /START154C/problems/XYZ)
  const contestMatch = cleanPath.match(/^\/([A-Za-z0-9_]+)\/problems\/([A-Za-z0-9_]+)$/i);
  if (contestMatch?.[1] && contestMatch?.[2]) {
    const contestId = contestMatch[1];
    if (contestId.toLowerCase() === 'practice') {
      return {
        contestId: 'Practice',
        problemCode: contestMatch[2],
      };
    }
    return {
      contestId,
      problemCode: contestMatch[2],
    };
  }

  return null;
}

/**
 * Extracts numeric submission ID from a CodeChef table row link.
 * Matches: `/viewsolution/<submissionId>`
 */
export function submissionIdFromRow(row: Element): string | null {
  const link = row.querySelector<HTMLAnchorElement>('a[href*="/viewsolution/"]');
  if (link) {
    const href = link.getAttribute('href') ?? '';
    const match = href.match(/\/viewsolution\/(\d+)/i);
    if (match?.[1]) return match[1];
  }

  // Fallback to data attributes on the row or child elements
  const rowElement = row as HTMLElement;
  const datasetId = rowElement.dataset?.['submissionId'];
  if (datasetId && /^\d+$/.test(datasetId)) return datasetId;

  const attrId = rowElement.getAttribute?.('data-submission-id');
  if (attrId && /^\d+$/.test(attrId)) return attrId;

  return null;
}

/**
 * Normalizes CodeChef language abbreviations to standard names.
 * Ensures compatibility with extension mapping in `src/lib/paths.ts`.
 * e.g. "PYTH 3" -> "Python 3", "PYTH" -> "Python", "PYPY3" -> "PyPy 3"
 */
export function normalizeLanguage(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  if (/^pyth(\s*3|\.3)$/i.test(lower)) return 'Python 3';
  if (/^pyth(on)?$/i.test(lower)) return 'Python';
  if (/^pypy(\s*3|-64)?$/i.test(lower)) return 'PyPy 3';
  if (/^c\+\+/i.test(lower) || /^cpp/i.test(lower)) return trimmed;
  if (/^java/i.test(lower)) return trimmed;
  if (/^c$/i.test(lower)) return 'C';
  if (/^rust/i.test(lower)) return 'Rust';
  if (/^go\b/i.test(lower)) return 'Go';
  if (/^kotlin/i.test(lower)) return 'Kotlin';

  return trimmed;
}

/**
 * Extracts language name from a CodeChef Recent Activity row.
 * In the standard 5-column table (Time | Problem | Result | Lang | Solution),
 * language resides in the 4th cell (index 3).
 */
export function extractLanguage(row: Element, normalize = true): string {
  const cells = Array.from(row.querySelectorAll('td'));

  // Positional extraction (4th cell in 5-cell layout)
  if (cells.length >= 4) {
    const langCell = cells[3];
    const raw = langCell.getAttribute('title') || langCell.textContent || '';
    const trimmed = raw.trim();
    if (trimmed && !trimmed.startsWith('/viewsolution')) {
      return normalize ? normalizeLanguage(trimmed) : trimmed;
    }
  }

  // Fallback: look for cell containing typical language tokens
  for (const cell of cells) {
    const text = (cell.getAttribute('title') || cell.textContent || '').trim();
    if (/^(pyth|pypy|c\+\+|cpp|java|rust|go\b|c$|kotlin|js|node)/i.test(text)) {
      return normalize ? normalizeLanguage(text) : text;
    }
  }

  return 'Unknown';
}

/**
 * Parses CodeChef Recent Activity timestamp (e.g. "08:42 PM 16/09/26")
 * into an ISO 8601 string.
 *
 * CodeChef displays dates in Indian Standard Time (IST, UTC+05:30) as:
 *   hh:mm A DD/MM/YY
 *
 * @param raw - The date string from the tooltip or title attribute.
 * @returns ISO 8601 UTC timestamp string.
 */
export function parseCodeChefDate(raw: string): string {
  if (!raw) return new Date().toISOString();

  // Pattern: "08:42 PM 16/09/26" or "8:42 AM 16/09/2026"
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/i);
  if (match) {
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const meridiem = match[3].toUpperCase();
    const day = parseInt(match[4], 10);
    const month = parseInt(match[5], 10);
    let year = parseInt(match[6], 10);

    if (year < 100) {
      year += 2000;
    }

    if (meridiem === 'PM' && hours < 12) {
      hours += 12;
    } else if (meridiem === 'AM' && hours === 12) {
      hours = 0;
    }

    const pad = (n: number) => n.toString().padStart(2, '0');
    const isoWithOffset = `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:00+05:30`;
    const d = new Date(isoWithOffset);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }

  // General fallback: standard Date.parse
  try {
    const d = new Date(raw.trim());
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch {
    // ignore
  }

  return new Date().toISOString();
}

/** Extracts submission timestamp from a CodeChef table row. */
export function extractTimestamp(row: Element): string {
  // Check tooltip element first: <span class="tooltiptext">08:42 PM 16/09/26</span>
  const tooltip = row.querySelector('.tooltiptext');
  if (tooltip?.textContent?.trim()) {
    return parseCodeChefDate(tooltip.textContent.trim());
  }

  // Check first cell title attribute: <td title="08:42 PM 16/09/26">
  const firstCell = row.querySelector('td');
  const title = firstCell?.getAttribute('title');
  if (title?.trim()) {
    return parseCodeChefDate(title.trim());
  }

  return new Date().toISOString();
}

/**
 * Extracts the logged-in username from CodeChef page context or DOM nodes.
 * Checked sources:
 *   1. window.codeChefUserData.user.username (React SPA state)
 *   2. window.Drupal.settings.currentUser (Drupal global)
 *   3. input#user_handle or input[name="user_handle"] (Recent Activity widget)
 *   4. span.m-username--link (Profile header)
 *   5. anchor a[href*="/users/"] (Navigation user block)
 */
export function extractLoggedInUsername(root?: Element | Document | null, win?: any): string | null {
  const contextWin = win ?? (typeof window !== 'undefined' ? window : null);
  if (contextWin) {
    if (contextWin.codeChefUserData?.user?.username) {
      const u = String(contextWin.codeChefUserData.user.username).trim();
      if (u) return u;
    }
    if (contextWin.Drupal?.settings?.currentUser) {
      const u = String(contextWin.Drupal.settings.currentUser).trim();
      if (u) return u;
    }
  }

  const contextDoc = root ?? (typeof document !== 'undefined' ? document : null);
  if (contextDoc) {
    const input = contextDoc.querySelector<HTMLInputElement>('input#user_handle, input[name="user_handle"]');
    if (input?.value?.trim()) return input.value.trim();

    const link = contextDoc.querySelector('.m-username--link');
    if (link?.textContent?.trim()) return link.textContent.trim();

    const anchors = Array.from(contextDoc.querySelectorAll<HTMLAnchorElement>('a[href*="/users/"]'));
    for (const a of anchors) {
      const href = a.getAttribute('href') ?? '';
      const match = href.match(/\/users\/([A-Za-z0-9_]+)/i);
      if (match?.[1]) {
        const candidate = match[1].trim();
        if (!['login', 'signup', 'download'].includes(candidate.toLowerCase())) {
          return candidate;
        }
      }
    }
  }

  return null;
}

/**
 * Extracts submission metadata from a live CodeChef Recent Activity table row.
 * Returns null if the row lacks a valid /viewsolution link or problem link.
 *
 * @param row    - The <tr> element from the Recent Activity table (.dataTable tbody tr).
 * @param origin - CodeChef origin (defaults to "https://www.codechef.com").
 */
export function parseSubmissionRow(row: Element, origin = 'https://www.codechef.com'): CodeChefRowData | null {
  const submissionId = submissionIdFromRow(row);
  if (!submissionId) return null;

  const probLink = row.querySelector<HTMLAnchorElement>('a[href*="/problems/"]');
  if (!probLink) return null;

  const probHref = probLink.getAttribute('href') ?? '';
  const problemInfo = parseProblemUrl(probHref);
  if (!problemInfo) return null;

  const rawTitle = probLink.textContent?.trim();
  const problemTitle = rawTitle || problemInfo.problemCode;

  const cleanHref = probHref.split('?')[0].split('#')[0];
  const problemUrl = cleanHref.startsWith('http') ? cleanHref : `${origin}${cleanHref}`;
  const submissionUrl = `${origin}/viewsolution/${submissionId}`;

  const language = extractLanguage(row);
  const submittedAt = extractTimestamp(row);
  const isAccepted = isAcceptedRow(row);

  return {
    submissionId,
    submissionUrl,
    contestId: problemInfo.contestId,
    problemId: problemInfo.problemCode,
    problemTitle,
    problemUrl,
    language,
    submittedAt,
    isAccepted,
  };
}

/**
 * Parses the raw payload from CodeChef's /api/submission-code/<submissionId> endpoint.
 * Returns exact source code and language metadata, or null if response is invalid or unsuccessful.
 */
export function parseSubmissionSourceResponse(payload: unknown): CodeChefSubmissionSourceResult | null {
  if (!payload) return null;

  let json: any = payload;
  if (typeof payload === 'string') {
    try {
      json = JSON.parse(payload);
    } catch {
      return null;
    }
  }

  if (typeof json !== 'object' || json === null) return null;
  if (json.status !== 'success' || !json.data) return null;

  const data = json.data;
  if (typeof data.code !== 'string' || data.code.length === 0) {
    return null;
  }

  const langObj = data.language;
  const shortName = typeof langObj?.short_name === 'string'
    ? langObj.short_name.trim()
    : (typeof langObj?.shortName === 'string' ? langObj.shortName.trim() : '');
  const fullName = typeof langObj?.full_name === 'string'
    ? langObj.full_name.trim()
    : (typeof langObj?.fullName === 'string' ? langObj.fullName.trim() : '');
  const extension = typeof langObj?.extension === 'string' ? langObj.extension.trim() : '';
  const id = langObj?.id != null ? String(langObj.id).trim() : undefined;

  return {
    code: data.code,
    language: {
      shortName,
      fullName,
      extension,
      ...(id ? { id } : {}),
    },
  };
}

/**
 * Retrieves the source code and language metadata for a submission via
 * CodeChef's verified /api/submission-code/<submissionId> endpoint.
 * Returns null if network fails, HTTP status is non-200, or payload is unsuccessful/malformed.
 */
export async function fetchSubmissionSource(
  submissionId: string,
  options?: FetchCodeChefSourceOptions
): Promise<CodeChefSubmissionSourceResult | null> {
  if (!submissionId || !/^\d+$/.test(submissionId.trim())) {
    return null;
  }

  const fetchFn = options?.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchFn) return null;

  const origin = options?.origin ?? (typeof window !== 'undefined' ? window.location.origin : 'https://www.codechef.com');
  const endpoint = `${origin}/api/submission-code/${encodeURIComponent(submissionId.trim())}`;

  try {
    const response = await fetchFn(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      credentials: 'same-origin',
    });

    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    return parseSubmissionSourceResponse(text);
  } catch {
    return null;
  }
}

/**
 * Builds a complete Submission object from parsed row metadata and fetched source code.
 */
export function submissionFromRowData(data: CodeChefRowData, sourceCode: string): Submission {
  return {
    platform: 'codechef',
    submissionId: data.submissionId,
    problemId: data.problemId,
    problemTitle: data.problemTitle,
    language: data.language,
    sourceCode,
    verdict: 'accepted',
    submittedAt: data.submittedAt,
    problemUrl: data.problemUrl || 'https://www.codechef.com',
    contest: data.contestId ?? 'Practice',
  };
}

/**
 * Returns true if pathname matches CodeChef user profile URL: /users/<username>
 */
export function isProfilePage(pathname: string): boolean {
  if (!pathname) return false;
  const clean = pathname.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return /^\/users\/[A-Za-z0-9_]+$/i.test(clean);
}

/**
 * Extracts the username from a CodeChef profile URL path: /users/<username>
 */
export function profileUsernameFromPath(pathname: string): string | null {
  if (!pathname) return null;
  const clean = pathname.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const match = clean.match(/^\/users\/([A-Za-z0-9_]+)$/i);
  return match ? match[1] : null;
}

/**
 * Returns true if the current path represents the profile of the currently logged-in user.
 * Prevents syncing submissions when browsing another user's profile.
 */
export function isLoggedInUserProfile(pathname: string, root?: Document | Element | null, win?: any): boolean {
  const profileUser = profileUsernameFromPath(pathname);
  if (!profileUser) return false;

  const loggedIn = extractLoggedInUsername(root, win);
  if (loggedIn) {
    return loggedIn.toLowerCase() === profileUser.toLowerCase();
  }
  return false;
}


