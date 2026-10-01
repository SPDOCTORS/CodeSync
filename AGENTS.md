# CodeSync Agent Guide

## Project map

- `src/options/App.tsx` is the settings UI and initiates sign-in, repository selection, and history import.
- `src/background/index.ts` owns extension messages, OAuth handoff, settings persistence, and repository verification.
- `src/background/sync.ts` owns the durable local queue and GitHub commit/retry behavior.
- `src/content/leetcode.ts` and `src/content/leetcode-adapter.ts` fetch and normalize signed-in LeetCode submission data.
- `server/index.mjs` is the Node OAuth and GitHub API proxy. It is deliberately separate from the extension bundle.

## Safety rules

- Never place GitHub OAuth credentials, GitHub access tokens, cookies, or extension session tokens in source, logs, tests, or documentation.
- Never clear `chrome.storage.local`, `chrome.storage.session`, `syncQueue`, `completedSubmissionKeys`, or `syncDiagnostics` while diagnosing or repairing synchronization.
- Do not create, delete, rename, or reset the configured GitHub repository as part of normal repair work.
- A successful import is not evidence of a GitHub commit. Treat a GitHub API success and the resulting repository file as the commit verification boundary.

## Change and verification expectations

- Preserve the current scope: GitHub OAuth, repository selection, LeetCode, and the existing queue only.
- Keep OAuth state validation, the `chromiumapp.org` redirect restriction, and the localhost-only HTTP exception intact.
- Prefer a minimal regression test whenever changing OAuth order, repository persistence, queue processing, or server startup.
- Run `npm test` and `npm run build` for extension code changes. Manually verify a real accepted LeetCode submission only after confirming the backend is running and a repository has been selected.
