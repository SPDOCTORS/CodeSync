# CodeSync Status Audit

Audited and repaired 2026-09-30 from the local source tree and local runtime checks. Extension storage, queued submissions, and the GitHub repository were not changed.

## Implemented features

| Area | Evidence |
| --- | --- |
| OAuth backend and opaque extension session handoff | `server/index.mjs` implements start, callback, one-time exchange, and session-backed GitHub proxy endpoints. |
| GitHub repository list, direct verification, and creation paths | `src/lib/github.ts`, `src/background/index.ts`, and `src/options/App.tsx`. |
| Durable queue with deduplication and retries | `src/background/sync.ts` uses `syncQueue`, `completedSubmissionKeys`, diagnostics, exponential retry, and explicit retry of permanent failures. |
| LeetCode live-detail capture and opt-in history import | `src/content/leetcode.ts` uses signed-in same-origin GraphQL details and routes Accepted submissions into the queue. |
| Build and automated tests | `npm test` passed 18 tests; `npm run build` passed on the audited tree. |

## Verified features

| Feature | Verification result |
| --- | --- |
| Unit/static test suite | Passed: 18 tests, including adapter normalization, queue behavior assertions, OAuth guards, and repository-selection assertions. |
| Production extension build | Passed: TypeScript check and Vite build completed. |
| Backend running locally | Not started during repair, by design. `npm run server:check` now verifies the unauthenticated readiness endpoint without sending credentials. |
| Real OAuth exchange with the recently changed secret | Not verified. The current value was intentionally not inspected or logged. |
| Existing repository selected | Not verified. No live backend session was available to call GitHub verification. |
| Real LeetCode solution commit | Not verified. Tests use fixtures and source-pattern assertions; no GitHub write was observed. |

## Broken or blocking behavior

| Blocker | Root cause and affected files |
| --- | --- |
| Backend cannot currently serve OAuth or commits | Repaired in source: `package.json` now exposes `npm run server` and `npm run server:check`; the server has a credential-free `/healthz` endpoint. It still must be started with the current runtime environment values. `server/index.mjs`, `server/healthcheck.mjs`, `package.json`. |
| Re-authentication can be blocked by a selected repository | Repaired in source: sign-in persists only the normalized backend URL before OAuth. Once OAuth succeeds, it verifies the existing repository and resumes the queue. `src/options/App.tsx`, `src/background/index.ts`. |
| Authentication status can look contradictory after backend/browser lifecycle changes | Repaired in source: Options and popup request an authenticated session probe. A 401 clears only `backendSession`, updates status, and retains the durable queue. `server/index.mjs`, `src/lib/github.ts`, `src/background/index.ts`, `src/popup/App.tsx`. |
| Repository selection has no live proof | The selection path is implemented and verifies `GET /v1/github/repos/{owner/repo}`, but cannot complete while the backend is down or its stored server session is gone. `src/options/App.tsx`, `src/background/index.ts`, `server/index.mjs`. |
| Successful LeetCode import does not prove GitHub delivery | Import counts an item as queued before the asynchronous GitHub contents API call is confirmed. The durable queue can retain it for retry. Only `commit-confirmed` diagnostics and the remote file/commit prove delivery. `src/content/leetcode.ts`, `src/background/sync.ts`. |

## Repository and environment observations

- This project directory is not itself a Git repository; Git resolves upward into an unrelated user-level repository. There is therefore no project-local remote or commit history to use as evidence of the target GitHub write.
- `.gitignore` excludes `.env` and `.env.*`. No secret-bearing file was opened.
- The server stores OAuth transactions, handoffs, and sessions only in memory. Restarting it necessarily requires a new OAuth sign-in; it does not erase the extension queue.
- The post-repair readiness command received HTTP 401 from `localhost:8787`. That indicates an older backend is currently answering on that port (the repaired server returns HTTP 200 from `/healthz` before authentication). Restart it from this updated project before browser verification.
