import {
  defaultRepoConfig,
  loadConfig,
  normalizeRepoConfig,
  saveConfig,
} from '../config/config.js';
import type { BumperConfig, RepoConfig } from '../config/config.types.js';
import { mapWithConcurrency } from '../utils/concurrency.utils.js';
import type { exec as execFn } from '../utils/exec.utils.js';
import { exec } from '../utils/exec.utils.js';
import type { Diagnostic, DiagnosticCollector } from './diagnostics.js';
import { collectDiagnostics, DEFAULT_COLLECTORS, FAST_COLLECTORS } from './diagnostics.js';
import type { LogStream, RepoStatus, RunEvent } from './events.js';
import type { RepoGraph } from './graph.js';
import { buildGraph, stageOf } from './graph.js';
import type { RepoRunOptions } from './runner.js';
import { RepoRun } from './runner.js';
import { scanWorkspace } from './scan.js';
import type { Runnable } from './scheduler.js';
import { Scheduler } from './scheduler.js';
import type { RepoInfo, WorkspaceScan } from './workspace.types.js';

/** A repo as the GUI sees it: scan data, graph position, config, diagnostics and run state. */
export interface RepoView extends RepoInfo {
  stage: number;
  upstream: string[];
  downstream: string[];
  config: RepoConfig;
  /** Whether `~/.bumperrc` has an entry (otherwise `config` is bumper's defaults). */
  configured: boolean;
  diagnostics: Diagnostic[];
  status?: RepoStatus;
  detail?: string;
}

export interface WorkspaceView {
  root: string;
  scannedAt: number;
  stages: string[][];
  cycles: string[][];
  ambiguous: { name: string; repos: string[] }[];
  repos: RepoView[];
  running: boolean;
}

export interface LogLine {
  stream: LogStream;
  line: string;
  at: number;
}

export type SessionEvent =
  | RunEvent
  | { type: 'workspace'; workspace: WorkspaceView }
  | { type: 'run'; running: boolean; at: number };

export interface RunRequest {
  selection: string[];
  /** Per-run "Ignore minimum release age". */
  ignoreReleaseAge?: boolean;
}

/** Everything the session reaches outside its own state; tests inject fakes. */
export interface SessionDeps {
  scan: (root: string, run: typeof execFn) => Promise<WorkspaceScan>;
  run: typeof execFn;
  loadConfig: () => Promise<BumperConfig>;
  saveConfig: (config: BumperConfig) => Promise<void>;
  createRun: (options: RepoRunOptions) => Runnable;
  collectors: readonly DiagnosticCollector[];
  fastCollectors: readonly DiagnosticCollector[];
  now: () => number;
  /** Log lines kept per repo (oldest dropped). */
  logLimit: number;
}

export interface SessionOptions {
  root: string;
  /** How to invoke bumper itself for the child `update` runs. */
  selfCommand: string[];
  /** Release wait timeout per repo. */
  waitTimeoutMs?: number;
  deps?: Partial<SessionDeps>;
}

const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000;
const DIAGNOSTIC_CONCURRENCY = 6;

/**
 * The state behind `bumper manage`: one workspace scan, its graph, the stored config, the
 * current run and a capped log per repo. Runtime-agnostic; the Bun server is a thin adapter that
 * forwards HTTP calls here and streams {@link SessionEvent}s over its socket. The run belongs to
 * the session, not to a browser tab — reloading the GUI never stops it.
 */
export class ManageSession {
  readonly root: string;
  readonly #deps: SessionDeps;
  readonly #options: SessionOptions;
  readonly #listeners = new Set<(event: SessionEvent) => void>();
  readonly #logs = new Map<string, LogLine[]>();
  readonly #state = new Map<string, { status: RepoStatus; detail?: string }>();
  #scan: WorkspaceScan | null = null;
  #graph: RepoGraph | null = null;
  #config: BumperConfig = { repos: {} };
  #diagnostics = new Map<string, Diagnostic[]>();
  #scannedAt = 0;
  #scheduler: Scheduler | null = null;

  constructor(options: SessionOptions) {
    this.root = options.root;
    this.#options = options;
    this.#deps = {
      scan: scanWorkspace,
      run: exec,
      loadConfig,
      saveConfig,
      createRun: runOptions => new RepoRun(runOptions),
      collectors: DEFAULT_COLLECTORS,
      fastCollectors: FAST_COLLECTORS,
      now: Date.now,
      logLimit: 2000,
      ...options.deps,
    };
  }

  /** Subscribe to events; returns the unsubscribe function. */
  on(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get running(): boolean {
    return (
      this.#scheduler !== null &&
      [...this.#scheduler.statuses.values()].some(
        status => !['done', 'failed', 'blocked', 'skipped'].includes(status)
      )
    );
  }

  /** (Re)scan the root, reload the config, recompute the graph and every diagnostic. */
  async scan(): Promise<WorkspaceView> {
    const [scan, config] = await Promise.all([
      this.#deps.scan(this.root, this.#deps.run),
      this.#deps.loadConfig(),
    ]);
    this.#scan = scan;
    this.#config = config;
    this.#graph = buildGraph(scan.repos);
    this.#scannedAt = this.#deps.now();
    await this.#refreshDiagnostics(this.#deps.collectors);
    return this.#publishWorkspace();
  }

  view(): WorkspaceView {
    const scan = this.#scan;
    const graph = this.#graph;
    if (scan === null || graph === null) {
      return {
        root: this.root,
        scannedAt: 0,
        stages: [],
        cycles: [],
        ambiguous: [],
        repos: [],
        running: false,
      };
    }
    return {
      root: this.root,
      scannedAt: this.#scannedAt,
      stages: graph.stages,
      cycles: graph.cycles,
      ambiguous: graph.ambiguous,
      running: this.running,
      repos: scan.repos.map(repo => ({
        ...repo,
        stage: stageOf(graph, repo.id),
        upstream: graph.upstream.get(repo.id) ?? [],
        downstream: graph.downstream.get(repo.id) ?? [],
        config: this.configFor(repo),
        configured: repo.path in this.#config.repos,
        diagnostics: this.#diagnostics.get(repo.id) ?? [],
        ...(this.#state.get(repo.id) ?? {}),
      })),
    };
  }

  /** The stored `~/.bumperrc`. */
  config(): BumperConfig {
    return this.#config;
  }

  /** Replace the whole config (the settings GUI saves the full file). */
  async updateConfig(next: BumperConfig): Promise<WorkspaceView> {
    this.#config = {
      ...(next.skipVersionCheck !== undefined ? { skipVersionCheck: next.skipVersionCheck } : {}),
      repos: Object.fromEntries(
        Object.entries(next.repos).map(([path, entry]) => [path, normalizeRepoConfig(entry)])
      ),
    };
    await this.#deps.saveConfig(this.#config);
    await this.#refreshDiagnostics(this.#deps.fastCollectors);
    return this.#publishWorkspace();
  }

  /** Set one repo's entry (creating it) and persist. */
  async updateRepoConfig(id: string, entry: RepoConfig): Promise<WorkspaceView> {
    const repo = this.#repo(id);
    return this.updateConfig({
      ...this.#config,
      repos: { ...this.#config.repos, [repo.path]: entry },
    });
  }

  /** The config a repo runs with: its stored entry, or bumper's defaults. */
  configFor(repo: RepoInfo): RepoConfig {
    const stored = this.#config.repos[repo.path];
    return stored ? normalizeRepoConfig(stored) : defaultRepoConfig();
  }

  logs(id: string): LogLine[] {
    return this.#logs.get(id) ?? [];
  }

  /** Start a run over `selection`. Rejects while another run is in progress. */
  async start(request: RunRequest): Promise<void> {
    if (this.running) {
      throw new Error('a run is already in progress');
    }
    const scan = this.#scan;
    const graph = this.#graph;
    if (scan === null || graph === null) {
      throw new Error('scan the workspace first');
    }
    const known = new Set(scan.repos.map(repo => repo.id));
    const selection = request.selection.filter(id => known.has(id));
    if (selection.length === 0) {
      throw new Error('nothing selected');
    }
    // a fresh run forgets the previous one's states and logs for the repos it touches
    selection.forEach(id => {
      this.#state.delete(id);
      this.#logs.delete(id);
    });
    const scheduler = new Scheduler({
      graph,
      repos: new Map(scan.repos.map(repo => [repo.id, repo])),
      selection,
      ignoreReleaseAge: request.ignoreReleaseAge ?? false,
      now: this.#deps.now,
      emit: event => this.#onRunEvent(event),
      createRun: (repo, allowYoung) =>
        this.#deps.createRun({
          repo,
          config: this.configFor(repo),
          selfCommand: this.#options.selfCommand,
          allowYoung,
          waitTimeoutMs: this.#options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
          emit: event => this.#onRunEvent(event),
        }),
    });
    this.#scheduler = scheduler;
    this.#emit({ type: 'run', running: true, at: this.#deps.now() });
    void scheduler
      .start()
      .then(() => this.#emit({ type: 'run', running: false, at: this.#deps.now() }));
  }

  retry(id: string): void {
    this.#scheduler?.retry(id);
    this.#afterControl();
  }

  runAnyway(id: string): void {
    this.#scheduler?.runAnyway(id);
    this.#afterControl();
  }

  skipWaiting(id: string): void {
    this.#scheduler?.skipWaiting(id);
  }

  /** Statuses of the current run, by repo id. */
  statuses(): Record<string, RepoStatus> {
    return Object.fromEntries(this.#scheduler?.statuses ?? []);
  }

  #repo(id: string): RepoInfo {
    const repo = this.#scan?.repos.find(entry => entry.id === id);
    if (repo === undefined) {
      throw new Error(`unknown repo: ${id}`);
    }
    return repo;
  }

  #afterControl(): void {
    const scheduler = this.#scheduler;
    if (scheduler !== null && this.running) {
      this.#emit({ type: 'run', running: true, at: this.#deps.now() });
      void scheduler
        .whenIdle()
        .then(() => this.#emit({ type: 'run', running: false, at: this.#deps.now() }));
    }
  }

  async #refreshDiagnostics(collectors: readonly DiagnosticCollector[]): Promise<void> {
    const scan = this.#scan;
    const graph = this.#graph;
    if (scan === null || graph === null) {
      return;
    }
    // bounded: the slow collectors spawn git and a registry `view` per repo
    const entries = await mapWithConcurrency(
      scan.repos,
      DIAGNOSTIC_CONCURRENCY,
      async repo =>
        [
          repo.id,
          await collectDiagnostics(
            { repo, graph, config: this.configFor(repo), run: this.#deps.run },
            collectors
          ),
        ] as const
    );
    // a fast refresh replaces only the fast collectors' output, keeping the slow results
    const fastCodes = new Set([
      'unsupported',
      'no-checks',
      'graph-cycle',
      'ambiguous-producer',
      'branch-switch',
    ]);
    this.#diagnostics = new Map(
      entries.map(([id, fresh]) => [
        id,
        collectors === this.#deps.fastCollectors
          ? [...(this.#diagnostics.get(id) ?? []).filter(d => !fastCodes.has(d.code)), ...fresh]
          : fresh,
      ])
    );
  }

  #onRunEvent(event: RunEvent): void {
    if (event.type === 'status') {
      this.#state.set(event.repo, {
        status: event.status,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      });
    } else {
      const lines = this.#logs.get(event.repo) ?? [];
      const next = [...lines, { stream: event.stream, line: event.line, at: event.at }];
      this.#logs.set(event.repo, next.slice(-this.#deps.logLimit));
    }
    this.#emit(event);
  }

  #publishWorkspace(): WorkspaceView {
    const workspace = this.view();
    this.#emit({ type: 'workspace', workspace });
    return workspace;
  }

  #emit(event: SessionEvent): void {
    this.#listeners.forEach(listener => listener(event));
  }
}
