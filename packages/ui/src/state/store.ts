import type {
  BumperConfig,
  LogLine,
  RepoConfig,
  RepoView,
  SessionEvent,
  WorkspaceView,
} from '@enke.dev/bumper-core/manage/view.types.js';
import { createContext } from '@lit/context';
import type { ReactiveController, ReactiveControllerHost } from 'lit';

import { api, connectEvents } from '../api/client.js';

export interface StoreState {
  workspace: WorkspaceView | null;
  connected: boolean;
  running: boolean;
  /** Repo ids ticked for the next run. */
  selection: ReadonlySet<string>;
  /** Repo whose log is shown. */
  focused: string | null;
  logs: LogLine[];
  ignoreReleaseAge: boolean;
  /** Repo whose settings drawer is open. */
  editing: string | null;
  /** Repos whose slow diagnostics are being collected right now. */
  diagnosing: ReadonlySet<string>;
  error: string | null;
  busy: boolean;
}

type Listener = (state: StoreState) => void;

/**
 * One store for the whole GUI, fed by the WebSocket and the JSON API. Components read it through
 * {@link StoreController}; every mutation goes through a method here so the server stays the
 * single source of truth for workspace and run state.
 */
export class ManageStore {
  #state: StoreState = {
    workspace: null,
    connected: false,
    running: false,
    selection: new Set(),
    focused: null,
    logs: [],
    ignoreReleaseAge: false,
    editing: null,
    diagnosing: new Set(),
    error: null,
    busy: false,
  };
  readonly #listeners = new Set<Listener>();
  #disconnect: (() => void) | null = null;

  get state(): StoreState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  connect(): void {
    this.#disconnect ??= connectEvents(
      event => this.#onEvent(event),
      connected => this.#patch({ connected })
    );
  }

  disconnect(): void {
    this.#disconnect?.();
    this.#disconnect = null;
  }

  repo(id: string | null): RepoView | undefined {
    return id === null ? undefined : this.#state.workspace?.repos.find(repo => repo.id === id);
  }

  /** Transitive dependents of a repo that are present in the workspace. */
  dependentsOf(id: string): string[] {
    const repos = this.#state.workspace?.repos ?? [];
    const seen = new Set<string>();
    const walk = (current: string): void =>
      (repos.find(repo => repo.id === current)?.downstream ?? []).forEach(next => {
        if (!seen.has(next)) {
          seen.add(next);
          walk(next);
        }
      });
    walk(id);
    return [...seen];
  }

  /** Selected upstream of an unselected repo: it would consume fresh versions it isn't picking up. */
  hasUpstreamChanges(id: string): boolean {
    const repo = this.repo(id);
    return (
      repo !== undefined &&
      !this.#state.selection.has(id) &&
      repo.upstream.some(up => this.#state.selection.has(up))
    );
  }

  toggle(id: string, checked: boolean): void {
    const selection = new Set(this.#state.selection);
    if (checked) {
      selection.add(id);
    } else {
      selection.delete(id);
    }
    this.#patch({ selection });
  }

  selectWithDependents(id: string): void {
    const selection = new Set(this.#state.selection);
    [id, ...this.dependentsOf(id)]
      .filter(entry => this.repo(entry)?.packageManager !== null)
      .forEach(entry => selection.add(entry));
    this.#patch({ selection });
  }

  clearSelection(): void {
    this.#patch({ selection: new Set() });
  }

  setIgnoreReleaseAge(value: boolean): void {
    this.#patch({ ignoreReleaseAge: value });
  }

  async focus(id: string | null): Promise<void> {
    this.#patch({ focused: id, logs: [] });
    if (id !== null) {
      // the slow diagnostics run lazily: first focus triggers them, the result arrives as an event
      if (this.repo(id)?.diagnosed === false) {
        void this.diagnose(id);
      }
      await this.#guard(async () => {
        const logs = await api.logs(id);
        if (this.#state.focused === id) {
          this.#patch({ logs });
        }
      });
    }
  }

  async diagnose(id: string): Promise<void> {
    this.#patch({ diagnosing: new Set([...this.#state.diagnosing, id]) });
    try {
      await api.diagnose(id);
    } catch (error) {
      this.#patch({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      const diagnosing = new Set(this.#state.diagnosing);
      diagnosing.delete(id);
      this.#patch({ diagnosing });
    }
  }

  edit(id: string | null): void {
    this.#patch({ editing: id });
  }

  dismissError(): void {
    this.#patch({ error: null });
  }

  rescan(): Promise<void> {
    return this.#guard(async () => {
      await api.rescan();
    });
  }

  start(): Promise<void> {
    return this.#guard(async () => {
      await api.start({
        selection: [...this.#state.selection],
        ignoreReleaseAge: this.#state.ignoreReleaseAge,
      });
    });
  }

  control(id: string, verb: 'retry' | 'run-anyway' | 'skip-waiting'): Promise<void> {
    return this.#guard(async () => {
      await api.control(id, verb);
    });
  }

  saveRepoConfig(id: string, config: RepoConfig): Promise<void> {
    return this.#guard(async () => {
      await api.saveRepoConfig(id, config);
    });
  }

  saveGlobal(patch: Partial<Pick<BumperConfig, 'skipVersionCheck'>>): Promise<void> {
    return this.#guard(async () => {
      const current = await api.config();
      const next: BumperConfig = { ...current, ...patch };
      if (next.skipVersionCheck === false) {
        delete next.skipVersionCheck;
      }
      await api.saveConfig(next);
    });
  }

  async #guard(fn: () => Promise<void>): Promise<void> {
    this.#patch({ busy: true, error: null });
    try {
      await fn();
    } catch (error) {
      this.#patch({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.#patch({ busy: false });
    }
  }

  #onEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'workspace': {
        // keep only selections that still exist and are still supported
        const ids = new Set(
          event.workspace.repos.filter(repo => repo.packageManager !== null).map(repo => repo.id)
        );
        this.#patch({
          workspace: event.workspace,
          running: event.workspace.running,
          selection: new Set([...this.#state.selection].filter(id => ids.has(id))),
        });
        return;
      }
      case 'run':
        this.#patch({ running: event.running });
        return;
      case 'diagnostics': {
        const workspace = this.#state.workspace;
        if (workspace === null) {
          return;
        }
        this.#patch({
          workspace: {
            ...workspace,
            repos: workspace.repos.map(repo =>
              repo.id === event.repo
                ? { ...repo, diagnostics: event.diagnostics, diagnosed: event.diagnosed }
                : repo
            ),
          },
        });
        return;
      }
      case 'status': {
        const workspace = this.#state.workspace;
        if (workspace === null) {
          return;
        }
        this.#patch({
          workspace: {
            ...workspace,
            repos: workspace.repos.map(repo =>
              repo.id === event.repo
                ? {
                    ...repo,
                    status: event.status,
                    ...(event.detail !== undefined
                      ? { detail: event.detail }
                      : { detail: undefined }),
                  }
                : repo
            ),
          },
        });
        return;
      }
      case 'log':
        if (event.repo === this.#state.focused) {
          this.#patch({
            logs: [...this.#state.logs, { stream: event.stream, line: event.line, at: event.at }],
          });
        }
        return;
    }
  }

  #patch(patch: Partial<StoreState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#listeners.forEach(listener => listener(this.#state));
  }
}

export const storeContext = createContext<ManageStore>(Symbol('bumper-store'));

/** Re-render the host whenever the store changes. */
export class StoreController implements ReactiveController {
  #unsubscribe: (() => void) | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly store: () => ManageStore | undefined
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.#unsubscribe = this.store()?.subscribe(() => this.host.requestUpdate()) ?? null;
  }

  hostDisconnected(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}
