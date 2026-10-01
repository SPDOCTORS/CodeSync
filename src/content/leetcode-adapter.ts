import type { Submission } from '../lib/types';

export type LeetCodeDetail = Record<string, unknown>;
export type TopicTag = { name?: unknown; slug?: unknown };
export type HistoryPage = { rows: Array<Record<string, unknown>>; nextKey: string | null };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Normalizes the signed-in submissionDetails GraphQL response used by LeetCode detail pages. */
export function detailFromGraphql(value: Record<string, unknown>): { detail: LeetCodeDetail; topicTags: TopicTag[] | undefined } {
  const question = value.question as Record<string, unknown> | undefined;
  const language = value.lang as Record<string, unknown> | string | undefined;
  const lang = typeof language === 'string' ? language : String(language?.name ?? language?.verboseName ?? '');
  return {
    detail: {
      id: value.id, question_id: question?.questionId, title: question?.title, title_slug: question?.titleSlug,
      lang, code: value.code, status_code: value.statusCode, status_msg: value.statusCode === 10 ? 'Accepted' : value.statusCode,
      timestamp: value.timestamp
    },
    topicTags: Array.isArray(question?.topicTags) ? question.topicTags as TopicTag[] : undefined
  };
}

export function isAccepted(detail: LeetCodeDetail): boolean {
  return detail.status_code === 10 || String(detail.status_msg ?? '').toLowerCase() === 'accepted';
}

export function isPending(detail: LeetCodeDetail): boolean {
  const status = String(detail.status_msg ?? '').toLowerCase();
  return detail.status_code == null || ['pending', 'judging', 'running'].includes(status);
}

export function hasSourceCode(detail: LeetCodeDetail): boolean { return typeof detail.code === 'string' && detail.code.length > 0; }

export function isAcceptedHistoryRecord(row: Record<string, unknown>): boolean {
  const status = row.status;
  return Number(status) === 10 || String(status ?? '').trim().toLowerCase() === 'accepted' || String(row.status_display ?? '').trim().toLowerCase() === 'accepted';
}

/** Supports the current response and the common nested response shape without logging any submission content. */
export function historyPageFromResponse(response: Record<string, unknown>): HistoryPage {
  const payload = isRecord(response.data) ? response.data : response;
  const rows = [payload.submissions_dump, payload.submissions, response.submissions_dump, response.submissions]
    .find(Array.isArray) as Array<Record<string, unknown>> | undefined;
  const rawNext = payload.last_key ?? payload.lastKey ?? response.last_key ?? response.lastKey;
  return { rows: rows ?? [], nextKey: typeof rawNext === 'string' && rawNext ? rawNext : null };
}

/** Stable alphabetical selection keeps every adapter run on the same topic path. */
export function primaryTopic(tags: TopicTag[] | undefined): string {
  const values = (tags ?? []).map(tag => String(tag.name ?? tag.slug ?? '').trim()).filter(Boolean);
  return values.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))[0] ?? 'Uncategorized';
}

export function submissionFromDetail(detail: LeetCodeDetail, topicTags?: TopicTag[]): Submission | null {
  if (!isAccepted(detail)) return null;
  const submissionId = String(detail.id ?? detail.submission_id ?? '').trim();
  const question = detail.question as { question_id?: unknown } | undefined;
  const problemId = String(detail.question_id ?? question?.question_id ?? '').trim();
  const problemTitle = String(detail.title ?? '').trim();
  const language = String(detail.lang ?? detail.lang_name ?? '').trim();
  const sourceCode = typeof detail.code === 'string' ? detail.code : '';
  const titleSlug = String(detail.title_slug ?? '').trim();
  if (!submissionId || !problemId || !problemTitle || !language || !sourceCode) return null;
  return {
    platform: 'leetcode', submissionId, problemId, problemTitle, language, sourceCode,
    verdict: 'accepted', submittedAt: detail.timestamp ? new Date(Number(detail.timestamp) * 1000).toISOString() : new Date().toISOString(),
    problemUrl: titleSlug ? `https://leetcode.com/problems/${titleSlug}/` : 'https://leetcode.com/', topic: primaryTopic(topicTags)
  };
}
