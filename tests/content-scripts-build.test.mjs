import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import test from 'node:test';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('manifest-injected content script entry files contain no top-level import/export statements', async () => {
  const manifestRaw = await read('public/manifest.json');
  const manifest = JSON.parse(manifestRaw);

  assert.ok(Array.isArray(manifest.content_scripts), 'manifest must declare content_scripts');
  assert.ok(manifest.content_scripts.length > 0, 'content_scripts must not be empty');

  // Collect all unique script paths declared in manifest content_scripts
  const contentScriptFiles = new Set();
  for (const entry of manifest.content_scripts) {
    if (Array.isArray(entry.js)) {
      for (const file of entry.js) {
        contentScriptFiles.add(file);
      }
    }
  }

  assert.ok(contentScriptFiles.has('assets/codeforces.js'), 'manifest must include assets/codeforces.js');

  for (const file of contentScriptFiles) {
    const distPath = `dist/${file}`;
    assert.ok(
      existsSync(new URL(`../${distPath}`, import.meta.url)),
      `Built content script file ${distPath} must exist in dist/`
    );

    const content = await read(distPath);

    // MV3 classic content scripts cannot use top-level ES module import statements
    assert.doesNotMatch(
      content,
      /^\s*import[\s{*(]/m,
      `Built content script ${file} contains an ES module import statement, which breaks Chrome MV3 classic script injection`
    );

    // MV3 classic content scripts cannot use top-level ES module export statements
    assert.doesNotMatch(
      content,
      /^\s*export[\s{*(]/m,
      `Built content script ${file} contains an ES module export statement, which breaks Chrome MV3 classic script injection`
    );
  }
});

test('codeforces.js in dist is a self-contained script without external module chunks', async () => {
  const content = await read('dist/assets/codeforces.js');
  // Specifically ensure no codeforces-rating or other chunk imports
  assert.doesNotMatch(content, /codeforces-rating-[A-Za-z0-9_-]+\.js/);
  assert.doesNotMatch(content, /from\s*['"][^'"]+\.js['"]/);
});

test('manifest declares action.default_icon and icons for 16, 32, 48, 128px and assets exist', async () => {
  const manifestRaw = await read('public/manifest.json');
  const manifest = JSON.parse(manifestRaw);

  const expectedSizes = ['16', '32', '48', '128'];
  assert.ok(manifest.action?.default_icon, 'manifest.action must declare default_icon');
  assert.ok(manifest.icons, 'manifest must declare icons');

  for (const size of expectedSizes) {
    const actionIconPath = manifest.action.default_icon[size];
    const generalIconPath = manifest.icons[size];

    assert.ok(actionIconPath, `manifest.action.default_icon must have size ${size}`);
    assert.ok(generalIconPath, `manifest.icons must have size ${size}`);

    assert.ok(
      existsSync(new URL(`../public/${actionIconPath}`, import.meta.url)),
      `Icon public/${actionIconPath} must exist`
    );
    assert.ok(
      existsSync(new URL(`../dist/${actionIconPath}`, import.meta.url)),
      `Built icon dist/${actionIconPath} must exist`
    );
  }

  assert.ok(
    existsSync(new URL('../public/icons/flow-streak.png', import.meta.url)),
    'Master asset public/icons/flow-streak.png must exist'
  );
  assert.ok(
    existsSync(new URL('../dist/icons/flow-streak.png', import.meta.url)),
    'Built master asset dist/icons/flow-streak.png must exist'
  );
});

test('popup header aligns logo and title, and flow platforms are arranged in 3+2 rows', async () => {
  const appTsx = await read('src/popup/App.tsx');
  const styleCss = await read('src/popup/style.css');

  // Verify brand-logo is included in header
  assert.match(appTsx, /<img\s+src="icons\/flow-streak\.png"\s+alt="CommitFlow"\s+className="brand-logo"\s*\/>/);
  assert.match(appTsx, /<div className="brand-text">\s*<h1>CommitFlow<\/h1>/);

  // Verify 3+2 platform rows structure
  assert.match(appTsx, /<div className="flow-platforms-cluster">[\s\S]*?<div className="flow-platforms-row">[\s\S]*?chip-leetcode[\s\S]*?chip-codeforces[\s\S]*?chip-codechef[\s\S]*?<\/div>[\s\S]*?<div className="flow-platforms-row">[\s\S]*?chip-cses[\s\S]*?chip-atcoder[\s\S]*?<\/div>/);

  // Verify CSS alignment rules
  assert.match(styleCss, /\.brand-logo\s*\{[^}]*width:\s*22px/);
  assert.match(styleCss, /\.brand-logo\s*\{[^}]*height:\s*22px/);
  assert.match(styleCss, /h1\s*\{[^}]*line-height:\s*22px/);
  assert.match(styleCss, /\.flow-platforms-cluster\s*\{[^}]*flex-direction:\s*column/);
  assert.match(styleCss, /\.flow-platforms-row\s*\{[^}]*justify-content:\s*center/);
  assert.match(styleCss, /\.flow-arrow-wrap\s*\{[^}]*justify-content:\s*center/);
  // Verify flow diagram uses approved Flow Streak PNG instead of old green branch icon
  assert.match(appTsx, /<img\s+src="icons\/flow-streak\.png"\s+alt="CommitFlow"\s+className="flow-node-logo"\s*\/>/);
  assert.doesNotMatch(appTsx, /CommitFlowIcon/);
  assert.match(styleCss, /\.flow-node-logo\s*\{[^}]*width:\s*20px/);
  assert.match(styleCss, /\.flow-node-logo\s*\{[^}]*height:\s*20px/);
});

test('connected popup includes compact footer with GitHub, issue templates, and author links', async () => {
  const appTsx = await read('src/popup/App.tsx');
  const styleCss = await read('src/popup/style.css');

  // Verify connected footer structure below Advanced
  assert.match(appTsx, /card-advanced[\s\S]*?<footer className="connected-footer">/);

  // Verify open source link
  assert.match(appTsx, /href="https:\/\/github\.com\/SPDOCTORS\/CodeSync"[^>]*>[\s\S]*?Open source on GitHub/);

  // Verify bug report with issue template
  assert.match(appTsx, /href="https:\/\/github\.com\/SPDOCTORS\/CodeSync\/issues\/new\?template=bug_report\.md&labels=bug&title=%5BBug%5D%3A\+"[^>]*>[\s\S]*?Report bug/);

  // Verify feature suggestion with issue template
  assert.match(appTsx, /href="https:\/\/github\.com\/SPDOCTORS\/CodeSync\/issues\/new\?template=feature_request\.md&labels=enhancement&title=%5BFeature%5D%3A\+"[^>]*>[\s\S]*?Suggest feature/);

  // Verify author attribution and social links
  assert.match(appTsx, /Built by <strong>Senthil Kumar<\/strong>/);
  assert.match(appTsx, /href="https:\/\/github\.com\/SPDOCTORS"[^>]*aria-label="Senthil Kumar on GitHub"/);
  assert.match(appTsx, /href="https:\/\/www\.linkedin\.com\/in\/senthil-kumar-76804730b\/"[^>]*aria-label="Senthil Kumar on LinkedIn"/);
  assert.doesNotMatch(appTsx, /href="https:\/\/www\.linkedin\.com\/in\/senthil-kumar"/);

  // Verify both GitHub issue templates exist
  assert.ok(existsSync(new URL('../.github/ISSUE_TEMPLATE/bug_report.md', import.meta.url)), 'bug_report.md must exist');
  assert.ok(existsSync(new URL('../.github/ISSUE_TEMPLATE/feature_request.md', import.meta.url)), 'feature_request.md must exist');

  // Verify styling
  assert.match(styleCss, /\.connected-footer\s*\{/);
  assert.match(styleCss, /\.footer-nav-link\s*\{/);
  assert.match(styleCss, /\.footer-author-text\s*\{/);
  assert.match(styleCss, /\.footer-author-row\s*\{[^}]*align-items:\s*center/);
  assert.match(styleCss, /\.footer-nav-row\s*\{[^}]*justify-content:\s*center/);

  // Verify reduced vertical gaps between cards
  assert.match(styleCss, /\.card-section\s*\{[^}]*margin-bottom:\s*6px/);
  assert.match(styleCss, /\.status-banner\s*\{[^}]*margin-bottom:\s*6px/);

  // Verify hidden scrollbars are scoped to popup and global * overrides are removed
  const popupHtml = await read('popup.html');
  assert.match(popupHtml, /<body\s+class="popup-body">/);
  assert.match(styleCss, /body\.popup-body[\s\S]*?scrollbar-width:\s*none/);
  assert.match(styleCss, /main:not\(\.wide\)[\s\S]*?scrollbar-width:\s*none/);
  assert.doesNotMatch(styleCss, /\*\s*\{[^}]*scrollbar-width/);
  assert.doesNotMatch(styleCss, /\*::-webkit-scrollbar/);
});

