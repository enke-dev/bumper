/// <reference types="bun" />
import type { BumperConfig, RepoConfig } from '@enke.dev/bumper-core/config/config.types.js';
import type { ManageSession, RunRequest } from '@enke.dev/bumper-core/manage/session.js';

export interface ServerOptions {
  session: ManageSession;
  /** The single-file GUI. */
  html: string;
  /** Random per-process secret; every request must carry it (query or header). */
  token: string;
  port: number;
  hostname?: string;
}

const TOPIC = 'events';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

/**
 * The local GUI server: static HTML, a JSON API over the session and one WebSocket topic that
 * mirrors every {@link SessionEvent}. Bound to loopback; a random token in the URL keeps other
 * origins from driving it (a page on another site can't read the token, so it can't call the API).
 */
export function startServer({ session, html, token, port, hostname = '127.0.0.1' }: ServerOptions) {
  const authorized = (req: Request, url: URL): boolean =>
    url.searchParams.get('token') === token || req.headers.get('x-bumper-token') === token;

  const api = async (req: Request, url: URL): Promise<Response> => {
    const path = url.pathname.replace(/^\/api/, '');
    const [, head, id, action] = path.split('/');
    if (req.method === 'GET' && head === 'workspace') {
      return json(session.view());
    }
    if (req.method === 'POST' && head === 'workspace' && id === 'rescan') {
      return json(await session.scan());
    }
    if (head === 'config' && id === undefined) {
      if (req.method === 'GET') {
        return json(session.config());
      }
      if (req.method === 'PUT') {
        return json(await session.updateConfig((await req.json()) as BumperConfig));
      }
    }
    if (req.method === 'PUT' && head === 'config' && id === 'repos' && action !== undefined) {
      const repoId = decodeURIComponent(path.split('/').slice(3).join('/'));
      return json(await session.updateRepoConfig(repoId, (await req.json()) as RepoConfig));
    }
    if (head === 'run' && id === undefined) {
      if (req.method === 'GET') {
        return json({ running: session.running, statuses: session.statuses() });
      }
      if (req.method === 'POST') {
        await session.start((await req.json()) as RunRequest);
        return json({ running: true });
      }
    }
    if (req.method === 'POST' && head === 'run' && id !== undefined && action !== undefined) {
      // repo ids contain slashes (`owner/repo`); the action is the last segment
      const segments = path.split('/').slice(2);
      const verb = segments.pop();
      const repoId = decodeURIComponent(segments.join('/'));
      switch (verb) {
        case 'retry':
          session.retry(repoId);
          return json({ ok: true });
        case 'run-anyway':
          session.runAnyway(repoId);
          return json({ ok: true });
        case 'skip-waiting':
          session.skipWaiting(repoId);
          return json({ ok: true });
      }
    }
    if (req.method === 'GET' && head === 'logs' && id !== undefined) {
      const repoId = decodeURIComponent(path.split('/').slice(2).join('/'));
      return json(session.logs(repoId));
    }
    return error('not found', 404);
  };

  const server = Bun.serve({
    hostname,
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (!authorized(req, url)) {
        return error('unauthorized', 401);
      }
      if (url.pathname === '/ws') {
        return srv.upgrade(req) ? undefined : error('websocket upgrade failed', 400);
      }
      if (url.pathname.startsWith('/api/')) {
        try {
          return await api(req, url);
        } catch (cause) {
          return error(cause instanceof Error ? cause.message : String(cause), 400);
        }
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return error('not found', 404);
    },
    websocket: {
      open(ws) {
        ws.subscribe(TOPIC);
        // a fresh socket gets the current picture first, then live events
        ws.send(JSON.stringify({ type: 'workspace', workspace: session.view() }));
        ws.send(JSON.stringify({ type: 'run', running: session.running, at: Date.now() }));
      },
      message() {
        // the GUI drives everything through the HTTP API; the socket is one-way
      },
      close(ws) {
        ws.unsubscribe(TOPIC);
      },
    },
  });

  const stop = session.on(event => {
    server.publish(TOPIC, JSON.stringify(event));
  });

  return {
    url: `http://${hostname}:${server.port}/?token=${token}`,
    async close(): Promise<void> {
      stop();
      await server.stop(true);
    },
  };
}
