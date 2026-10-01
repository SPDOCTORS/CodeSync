# CodeSync — Phase 3

Chrome Manifest V3 extension for organizing competitive-programming submissions in GitHub. Phase 3 adds a LeetCode Accepted-submission adapter while preserving the GitHub authorization, queue, retry, and deduplication foundation.

## Security model

The extension never includes a GitHub client secret or personal access token. `server/index.mjs` is a deployable OAuth backend that keeps the GitHub OAuth access token on the server. After the browser OAuth flow, it gives the extension a random, one-hour opaque session token held in `chrome.storage.session`; that token can only call the backend proxy.

The OAuth flow checks a random state, uses one-time authorization handoffs, and restricts the final callback to the extension's `chromiumapp.org` redirect URL. Deployed backends require HTTPS. The only HTTP exception is the exact local-development origin `http://localhost:8787`. The GitHub OAuth application needs the `repo` scope only because users may select private repositories and CodeSync must create and write repository contents. The Chrome extension requests `storage`, `identity`, and `alarms`; access to the selected backend is requested at sign-in.

## Setup

1. Create a GitHub OAuth App. For deployment, its authorization callback URL must be `https://YOUR_BACKEND/v1/oauth/github/callback`. For local development, set it to `http://localhost:8787/v1/oauth/github/callback`.
2. Deploy `server/index.mjs` behind HTTPS with Node 20+. Set `PUBLIC_BASE_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and optionally `PORT` in the deployment's secret manager. The included in-memory session store is suitable only for a single-process development deployment; use a shared TTL-backed store in production.
3. For local development, provide the values through your shell (never the extension source or committed files), then run the backend:

   ```powershell
   $env:PUBLIC_BASE_URL = 'http://localhost:8787'
   $env:GITHUB_CLIENT_ID = 'your-oauth-client-id'
   $env:GITHUB_CLIENT_SECRET = 'your-oauth-client-secret'
   npm run server
   ```

   In a separate terminal, verify that the backend is ready before starting OAuth:

   ```powershell
   npm run server:check
   ```

   The readiness check calls only `GET /healthz`; it does not send OAuth credentials or GitHub tokens. The backend's sessions are intentionally in memory, so restart it after changing the client secret and then sign in again in the extension. Existing local queue entries are preserved.

   `.env` and `.env.*` are ignored by Git. If you use a local environment file, load it through your deployment or shell tooling; `server/index.mjs` intentionally does not read secrets from extension assets.
4. Run `npm install` and `npm run build` in this folder.
5. Load `dist` from `chrome://extensions` with Developer mode enabled.
6. Open CodeSync settings, enter the HTTPS backend URL, or the exact local development URL `http://localhost:8787`, and choose **Sign in with GitHub**. Then create the private `Competitive-Programming` repository or select an existing one. Repository input accepts `owner/repo`, `https://github.com/owner/repo`, and `.git` URL variants.

### Development connection test

When the authorization server is exactly `http://localhost:8787`, Settings shows **Test GitHub Commit**. It is available only after an explicit click and only when the configured repository is `SPDOCTORS/Competitive-Programming`. It creates `CodeSync-Tests/connection-test.txt` containing `CodeSync GitHub integration test`. The request uses the existing backend session; no credentials are added to the extension. CodeSync records a successful test locally and never provides a file SHA, so it cannot overwrite an existing test file or any solution.

## Synchronization behavior

Future permitted adapters submit a verified `CODESYNC_QUEUE_SUBMISSION` message to the service worker. Each Accepted submission is committed independently with platform, problem name, language, and submission ID in the commit message. The path includes the submission ID, so multiple accepted solutions for the same problem are preserved. Queue entries and completed submission keys are stored locally; duplicate platform/submission-ID pairs are ignored. Transient failures retry with exponential backoff up to five attempts, and the popup reports pending, retrying, and error status.

Files use these paths:

- `LeetCode/<primary-topic>/<problem-id>-<title>-<submission-id>.<ext>`
- `Codeforces/<rating>/<problem-id>-<title>-<submission-id>.<ext>`
- `CodeChef/<contest>/<problem-id>-<title>-<submission-id>.<ext>`
- `AtCoder/<contest>/<problem-id>-<title>-<submission-id>.<ext>`
- `CSES/<topic>/<problem-id>-<title>-<submission-id>.<ext>`

## LeetCode adapter

The LeetCode content script observes the active submission-detail route. It obtains a candidate submission only from that route, then uses LeetCode's same-origin `submissionDetails` GraphQL operation while LeetCode is judging it. It queues code only after LeetCode reports `Accepted`. This avoids the REST `/submissions/detail/<id>/` endpoint, which may reject extension fetches with HTTP 403. The GraphQL result provides source, language, problem metadata, and topic tags through the signed-in browser session; the adapter chooses the alphabetically first tag by name, with `Uncategorized` for missing metadata.

Every queued LeetCode path is `LeetCode/<primary-topic>/<problem-id>-<title>-<submission-id>.<ext>`. The existing background queue deduplicates the platform/submission-ID pair, so distinct Accepted resubmissions remain separate.

To import history, first enable and save **Enable historical import from the signed-in LeetCode tab**, open an authenticated `leetcode.com` tab, then click **Import LeetCode history**. The adapter pages through submissions 20 at a time, inspects only Accepted entries, and delays requests by at least 750 ms. Progress and adapter errors appear in the popup status.

The import accepts both `leetcode.com` and `www.leetcode.com`. Before importing, CodeSync sends a ready handshake to the content script. If a matching tab was already open when the extension was reloaded, CodeSync injects only its packaged LeetCode adapter into that permitted tab and repeats the handshake. If either step fails, Settings explains whether to open or refresh the tab.

## Current limitations

Automatic submission detection is not implemented for Codeforces, CodeChef, CSES, or AtCoder. LeetCode live capture has unit coverage but has not yet been verified with a real Accepted browser submission. Historical import exists only for LeetCode and runs through the authenticated browser session; it does not bypass access controls, CAPTCHA, or rate limits.

### Manual browser verification

1. Rebuild with `npm run build`, reload the unpacked extension, and sign in through Settings.
2. Open an authenticated `https://leetcode.com` tab and submit a small solution that reaches Accepted.
3. Keep the result or submission-detail page open until the popup reports a synchronization status. Confirm a single new file appears under `LeetCode/<topic>/` and that the filename and commit contain the submission ID.
4. Submit the same problem again with a distinct Accepted submission ID; it should create a separate file. Refreshing the same detail page must not create another file.
5. Submit a Wrong Answer and confirm no file is created.
6. Optionally enable historical import in Settings and use the explicit import button. Keep the LeetCode tab open and observe popup progress.

If a detail lookup fails, open Chrome DevTools on the normal submission-detail page, reload it, and filter Network by `graphql`. Confirm the page requests `submissionDetails` from `https://leetcode.com/graphql/` and inspect only request names and status codes; do not copy cookies, authorization values, or other session data. The extension treats a failed historical item as skipped and continues the import.

## Verification

`npm run build` runs TypeScript checking and the production Vite build. There is no test runner in the existing project, so no automated test suite was available to execute.
