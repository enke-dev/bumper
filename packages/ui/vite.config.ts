import { defineConfig } from 'vite';
import litCss from 'vite-plugin-lit-css';

/** Stylesheets that stay plain CSS (page + Web Awesome); everything else becomes a lit CSSResult. */
const globalStyles = ['src/styles/**/*.css', '**/node_modules/**/*.css'];

/** The CLI's server during development (`bmpr manage --port 2011 --no-open`). */
const api = process.env['BUMPER_API'] ?? 'http://127.0.0.1:2011';

export default defineConfig({
  plugins: [litCss({ exclude: globalStyles })],
  build: {
    // flat, unhashed output: scripts/inline.ts folds it into one index.html for the CLI
    modulePreload: false,
    rollupOptions: {
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    // the block of bumper, s. the ports in ~/.claude/CLAUDE.md
    host: '127.0.0.1',
    port: 2010,
    strictPort: true,
    proxy: {
      '/api': api,
      '/ws': { target: api, ws: true },
    },
  },
});
