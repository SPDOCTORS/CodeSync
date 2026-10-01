import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('settings validates an absent service-worker response before reading ok', async () => {
  const options = await read('src/options/App.tsx');
  assert.match(options, /function isReply\(value: unknown\)/);
  assert.match(options, /if \(!isReply\(response\)\) return \{ ok: false/);
  assert.match(options, /const reply = await send\('CODESYNC_AUTH'\); setNotice\(reply\.ok/);
});

test('sign-in saves only the authorization server before OAuth and verifies an existing repository afterward', async () => {
  const [options, background] = await Promise.all([read('src/options/App.tsx'), read('src/background/index.ts')]);
  assert.match(options, /CODESYNC_SAVE_AUTHORIZATION_SERVER/);
  assert.match(options, /const authorizationServer = normalizeAuthorizationServer\(settings\.authorizationServer\)/);
  assert.doesNotMatch(options, /async function signIn\(\) \{\s*const next = await save\(\)/);
  assert.match(background, /async function saveAuthorizationServer/);
  assert.match(background, /if \(settings\?\.repository\) \{/);
  assert.match(background, /const verification = await verifyRepository\(settings\.repository\)/);
  assert.match(background, /Verified \$\{verification\.repository\}/);
});

test('backend startup and readiness check use no extension-bundled credentials', async () => {
  const [backend, healthcheck, packageJson] = await Promise.all([read('server/index.mjs'), read('server/healthcheck.mjs'), read('package.json')]);
  assert.match(backend, /url\.pathname === '\/healthz'/);
  assert.match(backend, /CodeSync backend listening at \$\{baseUrl\}/);
  assert.match(healthcheck, /fetch\(`\$\{baseUrl\}\/healthz`/);
  assert.match(healthcheck, /CODESYNC_BACKEND_URL/);
  assert.match(packageJson, /"server": "node server\/index\.mjs"/);
  assert.match(packageJson, /"server:check": "node server\/healthcheck\.mjs"/);
});

test('opening extension UI detects a backend-restart session loss without clearing the queue', async () => {
  const [options, popup, background, github, backend] = await Promise.all([read('src/options/App.tsx'), read('src/popup/App.tsx'), read('src/background/index.ts'), read('src/lib/github.ts'), read('server/index.mjs')]);
  assert.match(options, /send\('CODESYNC_AUTH_STATUS'\)/);
  assert.match(popup, /type: 'CODESYNC_AUTH_STATUS'/);
  assert.match(background, /async function checkAuthentication/);
  assert.match(background, /error\.status === 401/);
  assert.match(background, /chrome\.storage\.session\.remove\('backendSession'\)/);
  assert.doesNotMatch(background, /chrome\.storage\.local\.clear/);
  assert.match(github, /async checkSession/);
  assert.match(backend, /'\/v1\/github\/session'/);
});

test('permission request remains in the settings user gesture and service worker only checks it', async () => {
  const [options, background, manifest] = await Promise.all([read('src/options/App.tsx'), read('src/background/index.ts'), read('public/manifest.json')]);
  assert.match(options, /await chrome\.permissions\.request\(\{ origins: \[`\$\{next\.authorizationServer\}\/\*`\] \}\)/);
  assert.doesNotMatch(background, /chrome\.permissions\.request/);
  assert.match(background, /await chrome\.permissions\.contains/);
  assert.match(manifest, /"http:\/\/localhost:8787\/\*"/);
});

test('backend keeps the chromiumapp redirect restriction and localhost-only HTTP exception', async () => {
  const backend = await read('server/index.mjs');
  assert.match(backend, /configuredUrl\.hostname === 'localhost' && configuredUrl\.port === '8787'/);
  assert.match(backend, /chromiumapp\\\.org/);
});

test('development connection test is local-only, targets only the test path, and prevents repeats', async () => {
  const [options, sync, background] = await Promise.all([read('src/options/App.tsx'), read('src/background/sync.ts'), read('src/background/index.ts')]);
  assert.match(options, /normalizeAuthorizationServer\(settings\.authorizationServer\) === 'http:\/\/localhost:8787'/);
  assert.match(options, /Test GitHub Commit/);
  assert.match(sync, /CONNECTION_TEST_REPOSITORY = 'SPDOCTORS\/Competitive-Programming'/);
  assert.match(sync, /CONNECTION_TEST_PATH = 'CodeSync-Tests\/connection-test\.txt'/);
  assert.match(sync, /CONNECTION_TEST_CONTENT = 'CodeSync GitHub integration test'/);
  assert.match(sync, /completedConnectionTests/);
  assert.match(sync, /No SHA is supplied, so GitHub rejects an existing file rather than overwriting it/);
  assert.match(background, /CODESYNC_TEST_GITHUB_COMMIT/);
});

test('LeetCode history import is explicit, paginated, rate limited, and sent through the existing queue', async () => {
  const [options, background, adapter] = await Promise.all([read('src/options/App.tsx'), read('src/background/index.ts'), read('src/content/leetcode.ts')]);
  assert.match(options, /Import LeetCode history/);
  assert.match(background, /CODESYNC_IMPORT_LEETCODE_HISTORY/);
  assert.match(adapter, /CODESYNC_QUEUE_SUBMISSION/);
  assert.match(adapter, /Only the active detail route is automatic/);
  assert.match(adapter, /lastkey/);
  assert.match(adapter, /API_DELAY_MS = 750/);
});

test('LeetCode uses the signed-in GraphQL detail request and skips a failed historical item', async () => {
  const adapter = await read('src/content/leetcode.ts');
  assert.match(adapter, /query submissionDetails/);
  assert.match(adapter, /\/graphql\//);
  assert.match(adapter, /inaccessibleOrSkipped/);
  assert.match(adapter, /catch \{ counters\.inaccessibleOrSkipped \+= 1; \}/);
});

test('LeetCode import supports www, verifies a receiver, and injects only after a stale-tab handshake fails', async () => {
  const [manifest, background, adapter] = await Promise.all([read('public/manifest.json'), read('src/background/index.ts'), read('src/content/leetcode.ts')]);
  assert.match(manifest, /"https:\/\/www\.leetcode\.com\/\*"/);
  assert.match(manifest, /"scripting"/);
  assert.match(background, /url: \['https:\/\/leetcode\.com\/\*', 'https:\/\/www\.leetcode\.com\/\*'\]/);
  assert.match(background, /CODESYNC_LEETCODE_READY/);
  assert.match(background, /chrome\.scripting\.executeScript/);
  assert.match(background, /assets\/leetcode\.js/);
  assert.match(adapter, /CODESYNC_LEETCODE_READY/);
});

test('LeetCode import gives a useful response when no supported tab or receiver is available', async () => {
  const background = await read('src/background/index.ts');
  assert.match(background, /Open leetcode\.com or www\.leetcode\.com/);
  assert.match(background, /Refresh the LeetCode tab and try again/);
  assert.match(background, /adapter returned no import response/);
});

test('LeetCode history import emits safe outcome counters and continues pagination', async () => {
  const [adapter, options, popup] = await Promise.all([read('src/content/leetcode.ts'), read('src/options/App.tsx'), read('src/popup/App.tsx')]);
  assert.match(adapter, /totalRecords/);
  assert.match(adapter, /acceptedIdentified/);
  assert.match(adapter, /alreadySynchronized/);
  assert.match(adapter, /missingSourceCode/);
  assert.match(adapter, /failedQueueOperations/);
  assert.match(adapter, /pageSignatures/);
  assert.match(adapter, /rows\.length < HISTORY_PAGE_SIZE/);
  assert.match(options, /Synchronization status/);
  assert.match(popup, /chrome\.storage\.onChanged/);
});

test('GitHub sync keeps failed submissions durable and confirms commits before completion', async () => {
  const [sync, popup, background] = await Promise.all([read('src/background/sync.ts'), read('src/popup/App.tsx'), read('src/background/index.ts')]);
  assert.match(sync, /commit-confirmed/);
  assert.match(sync, /completed\.add\(key\)/);
  assert.match(sync, /item\.permanentlyFailed = true/);
  assert.match(sync, /retryFailedSubmissions/);
  assert.match(sync, /syncDiagnostics/);
  assert.match(popup, /Retry failed submissions/);
  assert.match(popup, /Latest GitHub error/);
  assert.match(background, /CODESYNC_RETRY_FAILED_SUBMISSIONS/);
});

test('existing repository selection is normalized, persisted, and resumes the queue', async () => {
  const [options, background] = await Promise.all([read('src/options/App.tsx'), read('src/background/index.ts')]);
  assert.match(options, /selectRepository/);
  assert.match(options, /await save\(next\)/);
  assert.match(options, /CODESYNC_SAVE_SETTINGS/);
  assert.match(background, /normalizeRepository\(settings\.repository\)/);
  assert.match(background, /await chrome\.storage\.local\.set\(\{ settings: next \}\); await processQueue\(\)/);
});

test('repository selection exposes list states and verifies an entered repository before persistence', async () => {
  const [options, background, github, backend] = await Promise.all([read('src/options/App.tsx'), read('src/background/index.ts'), read('src/lib/github.ts'), read('server/index.mjs')]);
  assert.match(options, /RepositoryLoadState/);
  assert.match(options, /Loading repositories/);
  assert.match(options, /No accessible repositories were returned/);
  assert.match(options, /Could not load repositories/);
  assert.match(options, /Use this repository/);
  assert.match(options, /CODESYNC_VERIFY_REPOSITORY/);
  assert.match(background, /async function verifyRepository/);
  assert.match(background, /await service\.verifyRepository\(repository\)/);
  assert.match(background, /const verification = await verifyRepository\(next\.repository\)/);
  assert.match(github, /async verifyRepository/);
  assert.match(backend, /GET' && repositoryMatch/);
});

test('server PUT /contents fetches existing file SHA before writing to support updates', async () => {
  const backend = await read('server/index.mjs');
  // Must GET the file first to retrieve its SHA
  assert.match(backend, /existing\.status === 200 \? \(await existing\.json\(\)\)\.sha/);
  // Must spread SHA conditionally into the PUT body
  assert.match(backend, /existingSha \? \{ sha: existingSha \}/);
  // Must not use the old SHA-less PUT pattern
  assert.doesNotMatch(backend, /JSON\.stringify\(\{ message, content: Buffer\.from\(content\)\.toString\('base64'\) \}\)/);
});
