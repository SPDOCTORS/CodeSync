import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Ensures content scripts are bundled as completely self-contained classic scripts.
 * In Chrome Manifest V3, content_scripts cannot use ES module import/export statements.
 * Tagging module resolutions originating from content scripts with a query prevents Rollup
 * from splitting shared dependencies (like codeforces-rating) into separate ES module chunks.
 */
function contentScriptInlinePlugin(): Plugin {
  return {
    name: 'content-script-inline',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (importer && (importer.includes('/src/content/') || importer.includes('\\src\\content\\') || importer.includes('?content-script'))) {
        const cleanImporter = importer.replace(/\?content-script.*$/, '');
        const resolved = await this.resolve(source, cleanImporter, { ...options, skipSelf: true });
        if (resolved && !resolved.external) {
          return `${resolved.id}?content-script`;
        }
      }
      return null;
    },
    load(id) {
      if (id.includes('?content-script')) {
        const filePath = id.split('?')[0];
        return readFileSync(filePath, 'utf-8');
      }
      return null;
    }
  };
}

export default defineConfig({
  plugins: [react(), contentScriptInlinePlugin()],
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: {
    popup: resolve(__dirname, 'popup.html'), options: resolve(__dirname, 'options.html'),
    background: resolve(__dirname, 'src/background/index.ts'),
    leetcode: resolve(__dirname, 'src/content/leetcode.ts'),
    codeforces: resolve(__dirname, 'src/content/codeforces.ts'),
    codechef: resolve(__dirname, 'src/content/codechef.ts'),
    cses: resolve(__dirname, 'src/content/cses.ts'),
    atcoder: resolve(__dirname, 'src/content/atcoder.ts')
  }, output: {entryFileNames: 'assets/[name].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames:'assets/[name]-[hash][extname]'} } }
});

