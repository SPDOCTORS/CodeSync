# Privacy Policy for CommitFlow v1.0

**Effective Date:** October 8, 2026  
**Extension Name:** CommitFlow (v1.0.0)  
**Repository:** [https://github.com/SPDOCTORS/CodeSync](https://github.com/SPDOCTORS/CodeSync)

CommitFlow ("we", "our", or "the extension") is a Chrome browser extension designed to help developers and students organize their accepted competitive programming solutions by committing them directly to their personal GitHub repositories. 

This Privacy Policy explains what data CommitFlow processes, where that data is stored, how authentication is handled, and how you can manage or delete your information.

---

## 1. Summary of Data Practices

- **Purpose-Driven Processing**: CommitFlow only processes submission metadata and source code that you voluntarily submit on supported competitive programming platforms when judged as **Accepted**.
- **No Third-Party Advertising or Tracking**: CommitFlow contains no advertising SDKs, tracking pixels, behavioral analytics, or third-party telemetry tools.
- **Zero-Secret Client Architecture**: The browser extension never receives or stores your GitHub Client Secret or GitHub Personal Access Token.
- **Direct User Ownership**: All synchronized code is stored solely on your local device and committed directly into your personal, designated GitHub repository.

---

## 2. Information We Process

### A. Competitive Programming Submissions
When you solve a problem on a supported platform (**LeetCode**, **Codeforces**, **CodeChef**, **CSES**, or **AtCoder**), the extension extracts the following information **only after** the verdict is confirmed as **Accepted**:
- **Problem Metadata**: Problem title, problem identifier, platform name, URL, and categorization tags (such as problem topic, difficulty, rating, or contest identifier).
- **Submission Metadata**: Unique submission ID, programming language (e.g., Python, C++, Java), and submission timestamp.
- **Source Code**: The exact source code of the accepted solution that you submitted to the platform.

*Note:* Failed, rejected, pending, or incorrect solutions (such as Wrong Answer, Time Limit Exceeded, or Compilation Error) are ignored and are not queued or synchronized.

### B. GitHub Account & Authentication Data
To commit files to your GitHub repository, CommitFlow initiates an OAuth authorization flow:
- **GitHub User Profile**: Used to retrieve your GitHub username and list accessible repositories so you can choose a destination repository.
- **OAuth Scope**: The backend requests GitHub's standard `repo` scope. Because GitHub OAuth Apps do not offer granular per-repository write permissions, the `repo` scope is required to allow CommitFlow to check repository access, auto-initialize the private `Competitive-Programming` repository, and commit solution files to public or private repositories that you specify. The backend strictly limits its GitHub API actions to reading your username, listing accessible repositories, reading file SHAs to support updates, and committing solutions to your selected repository. It never accesses pull requests, issues, releases, webhooks, or unselected repositories.
- **Session Tokens**: An opaque, 32-byte randomly generated session token is issued to the browser extension. The actual GitHub OAuth Access Token remains on the backend server and is never stored in browser storage.

---

## 3. How Authentication & OAuth Work

CommitFlow utilizes a dedicated, secure OAuth backend proxy (`server/index.mjs`):

```
[Browser Extension] ──(1. Start OAuth)──> [Backend Server] ──(2. Authorize)──> [GitHub]
[Browser Extension] <──(4. Opaque Token)─ [Backend Server] <──(3. Access Token)─ [GitHub]
```

1. **Transaction Security**: OAuth transactions use cryptographic random state parameters (`crypto.randomUUID()`) to prevent cross-site request forgery (CSRF).
2. **One-Time Handoff**: After GitHub callback verification, the backend issues a short-lived authorization handoff code (valid for 120 seconds).
3. **Token Isolation**: The backend exchanges the handoff code for an opaque session token sent to the extension. The underlying GitHub OAuth access token is stored securely server-side in a Redis session store (or local memory for development) and is never transmitted to the browser.
4. **Origin Validation**: OAuth redirects are strictly restricted to the extension's secure Chromium identity URL (`https://<extension-id>.chromiumapp.org/github`).

---

## 4. Where Data is Stored & Retention Periods

### A. Local Browser Storage (`chrome.storage.local` & `chrome.storage.session`)
The extension stores operational state locally on your machine:
- **`settings`**: User configuration including target repository (`owner/repo`), synchronization toggles, and backend URL.
- **`queue`**: Pending submissions waiting to be committed to GitHub. Each item is retained locally until successfully committed or manually discarded.
- **`committedKeys`**: List of previously processed submission keys (`<platform>:<submissionId>`) used to prevent duplicate commits.
- **`recentActivity`**: A rotating log of your **20 most recent** completed submissions (metadata only: platform, problem ID, title, language, submission time, sync time, and problem URL).
- **`backendSession`**: The opaque session token used to authenticate requests to the backend proxy.

*Retention:* 
- **Session Tokens**: Removed from local storage when you click **Disconnect** or uninstall the extension.
- **Settings, Queues & Activity**: Retained across disconnects to prevent loss of queued work or configuration, and permanently deleted when you uninstall the extension or clear Chrome extension storage.

### B. Backend Session Store (Redis / Memory)
The backend session proxy stores:
- **Session Entries**: `codesync:session:<sessionToken>` mapped to `{ githubToken, expires }`.
  - **Sliding TTL**: Configured with a sliding 1-year time-to-live (`ONE_YEAR_SECONDS = 31,536,000` seconds). Every authenticated API request made with the token refreshes the Redis key expiry by 1 year.
  - **Automatic Expiry**: If inactive for more than 1 year, the key expires automatically in Redis.
  - **Reactive Purge**: When an active token is revoked on GitHub, the backend receives an HTTP 401 from GitHub on the next API call (or `/v1/github/session` verification) and immediately executes `store.deleteSession(token)` to delete the key from Redis.
- **Temporary Transaction Keys**: `codesync:oauth:tx:<state>` (expires in 10 minutes, deleted immediately upon callback) and `codesync:oauth:handoff:<code>` (expires in 2 minutes, deleted immediately upon exchange).
- **No Solution Storage**: The backend **never stores or logs** your submitted source code, problem text, or solutions in Redis or databases. Solution payloads are streamed directly through to the GitHub Contents API over TLS.

---

## 5. Third-Party Services & Infrastructure

CommitFlow communicates with the following external services:

1. **GitHub API (`api.github.com`)**:
   - Transmits committed solutions, verifies repository existence, and creates the default `Competitive-Programming` repository upon user request.
   - Subject to the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement).
2. **Supported Competitive Programming Platforms**:
   - `leetcode.com`, `codeforces.com`, `codechef.com`, `cses.fi`, `atcoder.jp`.
   - Content scripts operate locally within your existing, authenticated browser sessions to detect submission verdicts and fetch source code via native platform endpoints.
3. **Backend Hosting & Database**:
   - **Default Server**: Hosted on Vercel (`code-sync-rho-brown.vercel.app`) with Upstash Redis for session state.
   - Self-hosted instances communicate exclusively with your designated backend server.

---

## 6. Chrome Permissions Used & Purpose

CommitFlow requests only the minimum permissions necessary to function:

| Permission | Purpose |
| :--- | :--- |
| `storage` | Saves user preferences, offline queue, recent sync history, and session tokens locally. |
| `identity` | Launches the secure GitHub OAuth consent flow via `chrome.identity.launchWebAuthFlow`. |
| `alarms` | Periodically checks the retry queue for failed or backoff-delayed commits. |
| `tabs` | Locates active LeetCode tabs to coordinate judging verification and historical imports. |
| `scripting` | Injects the LeetCode adapter script into already-open LeetCode tabs upon extension reload. |
| `host_permissions` | Allows network communication with `leetcode.com` and the backend authorization server. |

---

## 7. Data Deletion, Control & Revocation

You retain complete control over your data at all times:

1. **Disconnect Account (Local Action)**:
   - Clicking **Disconnect** in the CommitFlow popup removes `backendSession` from your browser storage (`chrome.storage.local` and `chrome.storage.session`) and halts background synchronization.
   - *Technical Note:* Disconnect is a client-side action; it does not make a backend network call to delete the Redis session key, and it preserves your saved repository settings, queue, and recent activity so work is not lost.
2. **Immediate Server-Side Revocation**:
   - To immediately and permanently revoke server-side access, revoke CommitFlow in your GitHub account settings:  
     **GitHub > Settings > Applications > Authorized OAuth Apps > Revoke CommitFlow**.
   - When revoked on GitHub, any subsequent API call through the backend proxy receives an HTTP 401 from GitHub, which immediately triggers `store.deleteSession()` to delete the session key from Redis.
3. **Local Extension Data Deletion**:
   - Uninstalling the CommitFlow extension immediately and permanently removes all stored data from your machine, including settings, queued submissions, duplicate tracking keys, and recent activity.
4. **Server-Side Data Deletion**:
   - The backend proxy maintains no persistent user accounts or solution databases. Sessions expire automatically via Redis TTL (1 year sliding expiry from last use) or are deleted upon token revocation. No solution code is retained on the backend.
5. **GitHub Solution Deletion**:
   - All committed code lives in your personal GitHub repository. You can modify, branch, or delete any committed files or repositories directly on GitHub. CommitFlow does not retain copies and does not possess deletion commands for your GitHub repositories.

---

## 8. Policy Updates

If we make material changes to how CommitFlow handles user data, we will update the version number of this document and note the changes in the project repository release notes.

---

## 9. Contact

If you have questions, feedback, or concerns regarding this Privacy Policy or CommitFlow's data handling practices, please open an issue on the official GitHub repository:

- **Issues & Support**: [https://github.com/SPDOCTORS/CodeSync/issues](https://github.com/SPDOCTORS/CodeSync/issues)
- **Maintainer**: Senthil Kumar ([GitHub](https://github.com/SPDOCTORS) | [LinkedIn](https://www.linkedin.com/in/senthil-kumar-76804730b/))
