/**
 * Codeforces problem rating lookup and caching service.
 *
 * Provides problem ratings via Codeforces API (contest.standings)
 * with multi-tier caching (in-memory + chrome.storage.local)
 * and fail-safe fallback to undefined (Unrated).
 */

const STORAGE_KEY = 'codeforcesRatingCache';

// In-memory cache for fast lookups within the current execution environment
const memoryCache = new Map<string, number | null>();

/**
 * Extracts a normalized lookup key for a problem, e.g. "1840C".
 */
export function problemRatingKey(contestId: string | number | null | undefined, problemIndexOrId: string): string | null {
  if (!problemIndexOrId) return null;
  const cleaned = problemIndexOrId.trim();
  if (contestId != null) {
    const cId = String(contestId).trim();
    if (cleaned.startsWith(cId)) return cleaned.toUpperCase();
    return `${cId}${cleaned}`.toUpperCase();
  }
  return cleaned.toUpperCase();
}

/**
 * Parses contest problem ratings from a Codeforces contest.standings API response.
 * Pure function suitable for unit tests without network calls.
 */
export function parseContestRatings(data: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (typeof data !== 'object' || data === null) return result;
  const root = data as {
    status?: string;
    result?: {
      problems?: Array<{
        contestId?: number;
        index?: string;
        rating?: number;
      }>;
    };
  };
  if (root.status !== 'OK' || !Array.isArray(root.result?.problems)) return result;

  for (const p of root.result.problems) {
    if (typeof p.contestId === 'number' && typeof p.index === 'string' && typeof p.rating === 'number') {
      const key = `${p.contestId}${p.index}`.toUpperCase();
      result[key] = p.rating;
    }
  }
  return result;
}

/**
 * Loads cached ratings from chrome.storage.local into memoryCache.
 */
async function loadStorageCache(): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const cache = stored[STORAGE_KEY] as Record<string, number | null> | undefined;
      if (cache) {
        for (const [k, v] of Object.entries(cache)) {
          memoryCache.set(k, v);
        }
      }
    }
  } catch {
    // Fail-safe: ignore storage read errors
  }
}

/**
 * Saves a map of problem ratings into memoryCache and chrome.storage.local.
 */
export async function saveRatingsToCache(ratings: Record<string, number | null>): Promise<void> {
  for (const [k, v] of Object.entries(ratings)) {
    memoryCache.set(k, v);
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const existing = (stored[STORAGE_KEY] as Record<string, number | null> | undefined) ?? {};
      const updated = { ...existing, ...ratings };
      await chrome.storage.local.set({ [STORAGE_KEY]: updated });
    }
  } catch {
    // Fail-safe: ignore storage write errors
  }
}

/**
 * Looks up the rating for a Codeforces problem.
 * 1. Checks memory cache.
 * 2. Checks chrome.storage.local.
 * 3. Fetches from Codeforces API (https://codeforces.com/api/contest.standings?contestId=...)
 *    and caches all problems in that contest.
 * 4. Returns the rating (number) if rated, or undefined if unrated or lookup fails.
 */
export async function getProblemRating(
  contestId: string | number | null | undefined,
  problemIndexOrId: string,
  fetchFn: typeof fetch = fetch,
): Promise<number | undefined> {
  const key = problemRatingKey(contestId, problemIndexOrId);
  if (!key) return undefined;

  // 1. Check in-memory cache
  if (memoryCache.has(key)) {
    const cached = memoryCache.get(key);
    return typeof cached === 'number' ? cached : undefined;
  }

  // 2. Check storage cache
  await loadStorageCache();
  if (memoryCache.has(key)) {
    const cached = memoryCache.get(key);
    return typeof cached === 'number' ? cached : undefined;
  }

  // 3. Fetch from Codeforces API if contestId is available
  const cId = contestId != null ? String(contestId).trim() : null;
  if (!cId || !/^\d+$/.test(cId)) {
    memoryCache.set(key, null);
    return undefined;
  }

  try {
    const url = `https://codeforces.com/api/contest.standings?contestId=${encodeURIComponent(cId)}`;
    const response = await fetchFn(url);
    if (!response.ok) {
      memoryCache.set(key, null);
      return undefined;
    }
    const data = await response.json();
    const parsed = parseContestRatings(data);

    if (Object.keys(parsed).length > 0) {
      await saveRatingsToCache(parsed);
      const rating = parsed[key];
      if (typeof rating === 'number') return rating;
    }

    // Problem found in contest standings but has no rating (unrated)
    memoryCache.set(key, null);
    await saveRatingsToCache({ [key]: null });
    return undefined;
  } catch {
    // Fail-safe: network error, API rate limit, offline -> fallback to undefined (Unrated)
    return undefined;
  }
}
