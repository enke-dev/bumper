import type {
  BumperConfig,
  LogLine,
  RepoConfig,
  RunRequest,
  SessionEvent,
  WorkspaceView,
} from '@enke.dev/bumper-core/manage/view.types.js';

/** The per-process secret the server put into the page URL; sent back with every call. */
const token = new URLSearchParams(location.search).get('token') ?? '';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      'x-bumper-token': token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? `${method} ${path} failed (${response.status})`);
  }
  return data;
}

const encode = (id: string): string => encodeURIComponent(id);

/** What the user can do to a repo inside a run. */
export type ControlVerb = 'retry' | 'run-anyway' | 'push' | 'keep-local' | 'skip-waiting';

export const api = {
  workspace: () => call<WorkspaceView>('GET', '/api/workspace'),
  rescan: () => call<WorkspaceView>('POST', '/api/workspace/rescan'),
  diagnose: (id: string) => call<unknown>('POST', `/api/workspace/${encode(id)}/diagnose`),
  fastForward: (id: string) => call<unknown>('POST', `/api/workspace/${encode(id)}/fast-forward`),
  config: () => call<BumperConfig>('GET', '/api/config'),
  saveConfig: (config: BumperConfig) => call<WorkspaceView>('PUT', '/api/config', config),
  saveRepoConfig: (id: string, config: RepoConfig) =>
    call<WorkspaceView>('PUT', `/api/config/repos/${encode(id)}`, config),
  start: (request: RunRequest) => call<{ running: boolean }>('POST', '/api/run', request),
  control: (id: string, verb: ControlVerb) =>
    call<{ ok: boolean }>('POST', `/api/run/${encode(id)}/${verb}`),
  logs: (id: string) => call<LogLine[]>('GET', `/api/logs/${encode(id)}`),
  clearLogs: (id: string) => call<{ ok: boolean }>('DELETE', `/api/logs/${encode(id)}`),
};

/**
 * Subscribe to the server's event stream; reconnects with backoff when the socket drops (the
 * server survives page reloads, the page must survive server hiccups). Returns a disposer.
 */
export function connectEvents(
  onEvent: (event: SessionEvent) => void,
  onState: (connected: boolean) => void
): () => void {
  const state = { socket: null as WebSocket | null, closed: false, delay: 500 };
  const open = (): void => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws?token=${token}`);
    state.socket = socket;
    socket.onopen = () => {
      state.delay = 500;
      onState(true);
    };
    socket.onmessage = message => onEvent(JSON.parse(String(message.data)) as SessionEvent);
    socket.onclose = () => {
      onState(false);
      if (!state.closed) {
        setTimeout(open, state.delay);
        state.delay = Math.min(state.delay * 2, 10_000);
      }
    };
  };
  open();
  return () => {
    state.closed = true;
    state.socket?.close();
  };
}
