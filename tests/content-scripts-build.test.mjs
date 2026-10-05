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
