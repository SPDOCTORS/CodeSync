import type { Submission } from './types';
const slug = (s: string) => s.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'unknown';
const ext: Record<string, string> = {
  python: 'py', 'python 3': 'py', python3: 'py',
  pypy: 'py', 'pypy 3': 'py', 'pypy 3-64': 'py', pypy3: 'py',
  'c++': 'cpp', cpp: 'cpp', 'gnu c++17': 'cpp', 'gnu c++17 (64)': 'cpp', 'gnu c++20': 'cpp', 'gnu c++20 (64)': 'cpp',
  java: 'java', 'java 21': 'java', 'java 17': 'java', 'java 8': 'java',
  javascript: 'js', typescript: 'ts', c: 'c', 'gnu c': 'c', rust: 'rs', go: 'go', kotlin: 'kt'
};
function extensionFor(raw: string): string {
  const lang = raw.trim().toLowerCase();
  if (ext[lang]) return ext[lang];
  if (lang.startsWith('python') || lang.startsWith('pypy')) return 'py';
  if (lang.includes('c++')) return 'cpp';
  if (lang.startsWith('java') && !lang.startsWith('javascript')) return 'java';
  return 'txt';
}
export function pathFor(s: Submission): string {
  const extension = extensionFor(s.language);
  const filename = `${slug(s.problemId)}-${slug(s.problemTitle)}-${slug(s.submissionId)}.${extension}`;
  switch(s.platform) {
    case 'codeforces': return `Codeforces/${s.rating == null ? 'Unrated' : s.rating}/${filename}`;
    case 'leetcode': return `LeetCode/${slug(s.topic ?? s.difficulty ?? 'Uncategorized')}/${filename}`;
    case 'codechef': return `CodeChef/${slug(s.contest ?? 'Practice')}/${filename}`;
    case 'cses': return `CSES/${slug(s.topic ?? 'Uncategorized')}/${filename}`;
    case 'atcoder': return `AtCoder/${slug(s.contest ?? 'Practice')}/${filename}`;
  }
}
export function submissionKey(s: Submission): string { return `${s.platform}:${s.submissionId}`; }
