import type { ChildProcess, ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
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
 * itself carries no token; the proxy adds it, so plain http://127.0.0.1:2010/ works. Edits to the
 * core or cli sources restart it (an update in progress is cut off, fine for development).
 */
function manageServer(): Plugin {
  const cli = fileURLToPath(new URL('../cli/src/cli.ts', import.meta.url));
  const sources = ['../core/src/', '../cli/src/'].map(dir =>
    fileURLToPath(new URL(dir, import.meta.url))
  );

  /** Spawn the server; resolves once it printed its URL (and with it the new token). */
  const start = (): Promise<ChildProcessByStdio<null, Readable, null>> => {
    const child = spawn('bun', [cli, 'manage', '--port', String(apiPort), '--no-open'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        process.stdout.write(chunk);
        const [, token] = /[?&]token=([\w-]+)/.exec(chunk.toString()) ?? [];
        if (token) {
          session.token = token;
          resolve(child);
        }
      });
      child.once('exit', code => reject(new Error(`bmpr manage exited early (${code})`)));
    });
  };

  /** Stop and wait for the exit, so the next start finds the port free. */
  const stop = (child: ChildProcess): Promise<void> =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise(resolve => {
          child.once('exit', () => resolve());
          child.kill('SIGINT');
        });

  return {
    name: 'bumper-manage-server',
    apply: 'serve',
    async configureServer(server) {
      // vite waits for this hook, so the first page load already finds the API up
      const state = {
        child: await start(),
        restart: Promise.resolve(),
        timer: undefined as NodeJS.Timeout | undefined,
      };

      server.watcher.add(sources);
      server.watcher.on('change', file => {
        if (!sources.some(dir => file.startsWith(dir)) || file.includes('.spec.')) {
          return;
        }
        // an editor save fires several events; restart once, after the burst, one at a time
        clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state.restart = state.restart
            .then(async () => {
              server.config.logger.info('core/cli changed, restarting bmpr manage', {
                timestamp: true,
              });
              await stop(state.child);
              state.child = await start();
            })
            .catch((error: unknown) => server.config.logger.error(String(error)));
        }, 200);
      });

      server.httpServer?.once('close', () => void stop(state.child));
      process.once('exit', () => state.child.kill());
      // a signal's default exit skips 'exit' handlers, which would orphan the server on 2011
      process.once('SIGINT', () => {
        void stop(state.child)
          .then(() => server.close())
          .finally(() => process.exit(130));
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
