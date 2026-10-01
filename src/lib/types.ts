export type Platform = 'leetcode' | 'codeforces' | 'codechef' | 'cses' | 'atcoder';
export type Verdict = 'accepted' | 'rejected' | 'pending';
export interface Submission {
  platform: Platform;
  submissionId: string;
  problemId: string;
  problemTitle: string;
  language: string;
  sourceCode: string;
  verdict: Verdict;
  submittedAt: string;
  problemUrl: string;
  difficulty?: 'Easy' | 'Medium' | 'Hard';
  rating?: number;
  contest?: string;
  topic?: string;
}
export interface Settings {
  enabled: boolean;
  repository: string;
  commitEveryAccepted: true;
  importHistory: boolean;
  /** HTTPS authorization service, or the exact localhost development service, that owns GitHub secrets. */
  authorizationServer: string;
}
export interface SyncStatus {
  state: 'idle' | 'authorizing' | 'syncing' | 'retrying' | 'error';
  message: string;
  pending: number;
  lastSyncedAt?: string;
  counts?: { pending: number; retrying: number; committed: number; permanentlyFailed: number };
  latestGitHubError?: string;
}
export interface QueueItem { submission: Submission; attempts: number; nextAttemptAt: number; permanentlyFailed?: boolean; lastError?: string; }
export interface SyncDiagnostic { at: string; stage: 'enqueued' | 'commit-attempt' | 'commit-confirmed' | 'retry-scheduled' | 'permanently-failed' | 'session-missing'; submissionKey?: string; message: string; }
export const DEFAULT_SETTINGS: Settings = {
  enabled: true, repository: '', commitEveryAccepted: true, importHistory: false, authorizationServer: ''
};
export const DEFAULT_SYNC_STATUS: SyncStatus = { state: 'idle', message: 'GitHub is not connected.', pending: 0 };
