import type { Submission } from './types';
const slug = (s: string) => s.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'unknown';
const ext: Record<string,string> = {python:'py',python3:'py',pypy:'py',pypy3:'py', 'c++':'cpp',cpp:'cpp', 'gnu c++17':'cpp', 'gnu c++20':'cpp',java:'java',javascript:'js',typescript:'ts',c:'c',rust:'rs',go:'go',kotlin:'kt'};
export function pathFor(s: Submission): string {
  const language = s.language.trim().toLowerCase();
  const extension = ext[language] ?? 'txt';
  const filename = `${slug(s.problemId)}-${slug(s.problemTitle)}-${slug(s.submissionId)}.${extension}`;
  switch(s.platform) {
    case 'codeforces': return `Codeforces/${s.rating == null ? 'Unrated' : Math.floor(s.rating / 100) * 100}/${filename}`;
    case 'leetcode': return `LeetCode/${slug(s.topic ?? s.difficulty ?? 'Uncategorized')}/${filename}`;
    case 'codechef': return `CodeChef/${slug(s.contest ?? 'Practice')}/${filename}`;
    case 'cses': return `CSES/${slug(s.topic ?? 'Uncategorized')}/${filename}`;
    case 'atcoder': return `AtCoder/${slug(s.contest ?? 'Practice')}/${filename}`;
  }
}
export function submissionKey(s: Submission): string { return `${s.platform}:${s.submissionId}`; }
