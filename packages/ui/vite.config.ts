import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { Plugin, ProxyOptions } from 'vite';
import { defineConfig } from 'vite';
import litCss from 'vite-plugin-lit-css';

/** Stylesheets that stay plain CSS (page + Web Awesome); everything else becomes a lit CSSResult. */
const globalStyles = ['src/styles/**/*.css', '**/node_modules/**/*.css'];

/** The CLI's server during development, s. the ports in ~/.claude/CLAUDE.md */
const apiPort = 2011;
const api = `http://127.0.0.1:${apiPort}`;

/** The per-process token the manage server prints; read from its output, injected into proxied calls. */
const session = { token: '' };

/**
 * Runs `bmpr manage` from source next to the dev server, so the GUI has its backend. The page
 * itself carries no token; the proxy adds it, so plain http://127.0.0.1:2010/ works.
 */
function manageServer(): Plugin {
  return {
    name: 'bumper-manage-server',
    apply: 'serve',
    async configureServer(server) {
      const cli = fileURLToPath(new URL('../cli/src/cli.ts', import.meta.url));
      const child = spawn('bun', [cli, 'manage', '--port', String(apiPort), '--no-open'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      server.httpServer?.once('close', () => child.kill('SIGINT'));
      process.once('exit', () => child.kill());
      // a signal's default exit skips 'exit' handlers, which would orphan the server on 2011
      process.once('SIGINT', () => {
        child.kill('SIGINT');
        void server.close().finally(() => process.exit(130));
      });

      // vite waits for this hook, so the first page load already finds the API up
      session.token = await new Promise<string>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => {
          process.stdout.write(chunk);
          const [, token] = /[?&]token=([\w-]+)/.exec(chunk.toString()) ?? [];
          if (token) {
            resolve(token);
          }
        });
        child.once('exit', code => reject(new Error(`bmpr manage exited early (${code})`)));
      });
    },
  };
}

const withToken: ProxyOptions['configure'] = proxy => {
  proxy.on('proxyReq', req => req.setHeader('x-bumper-token', session.token));
  proxy.on('proxyReqWs', req => req.setHeader('x-bumper-token', session.token));
};

export default defineConfig({
  plugins: [litCss({ exclude: globalStyles }), manageServer()],
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
      '/api': { target: api, configure: withToken },
      '/ws': { target: api, ws: true, configure: withToken },
    },
  },
});
