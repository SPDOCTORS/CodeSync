import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
  plugins: [react()],
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
