import type { EventSink, RepoStatus } from './events.js';
import { SATISFIED } from './events.js';
import type { RepoGraph } from './graph.js';
import type { RepoInfo } from './workspace.types.js';

/** The part of {@link RepoRun} the scheduler drives; tests pass fakes. */
export interface Runnable {
  run(): Promise<RepoStatus>;
  skipWaiting(): void;
}

export interface SchedulerOptions {
  graph: RepoGraph;
  repos: ReadonlyMap<string, RepoInfo>;
  /** Repo ids the user ticked. Only these run; unselected upstreams are ignored. */
  selection: readonly string[];
  /** Build the run for a repo; `allowYoung` are the packages its selected upstreams publish. */
  createRun: (repo: RepoInfo, allowYoung: string[]) => Runnable;
  emit: EventSink;
  /**
   * "Ignore minimum release age": pass every upstream producer's packages as allow-young, selected
   * or not, so the update may take their newest versions regardless of age.
   */
  ignoreReleaseAge?: boolean;
  now?: () => number;
}

/**
 * Dependency-ordered execution over the selection: a repo starts once every *selected* upstream
 * finished successfully, runs in parallel with everything else that is ready, and is blocked when
 * a selected upstream failed. Retry re-queues a repo and its blocked dependents; run-anyway starts
 * a blocked repo regardless; skip-waiting ends its release wait.
 */
export class Scheduler {
  readonly statuses = new Map<string, RepoStatus>();
  readonly #running = new Map<string, Runnable>();
  readonly #options: SchedulerOptions;
  #idle: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(options: SchedulerOptions) {
    this.#options = options;
    options.selection.forEach(id => this.statuses.set(id, 'queued'));
  }

  /** Start everything that is ready; resolves once nothing runs any more. */
  start(): Promise<void> {
    this.#tick();
    return this.whenIdle();
  }

  /** Resolves when no repo is running (immediately when idle). */
  whenIdle(): Promise<void> {
    if (this.#running.size === 0) {
      return Promise.resolve();
    }
    if (this.#idle === null) {
      let resolve = (): void => undefined;
      const promise = new Promise<void>(done => {
        resolve = done;
      });
      this.#idle = { promise, resolve };
    }
    return this.#idle.promise;
  }

  /** Re-queue a failed/blocked repo (and its blocked dependents), then start what is ready. */
  retry(id: string): void {
    const status = this.statuses.get(id);
    if (status !== 'failed' && status !== 'blocked') {
      return;
    }
    this.#set(id, 'queued');
    this.#selectedDependents(id)
      .filter(dep => this.statuses.get(dep) === 'blocked')
      .forEach(dep => this.#set(dep, 'queued'));
    this.#tick();
  }

  /** Start a blocked repo despite its failed upstreams (it consumes whatever is published). */
  runAnyway(id: string): void {
    if (this.statuses.get(id) === 'blocked') {
      this.#launch(id);
    }
  }

  skipWaiting(id: string): void {
    this.#running.get(id)?.skipWaiting();
  }

  #set(id: string, status: RepoStatus, detail?: string): void {
    this.statuses.set(id, status);
    this.#options.emit({
      type: 'status',
      repo: id,
      status,
      ...(detail !== undefined ? { detail } : {}),
      at: (this.#options.now ?? Date.now)(),
    });
  }

  #selectedUpstreams(id: string): string[] {
    return (this.#options.graph.upstream.get(id) ?? []).filter(up => this.statuses.has(up));
  }

  #selectedDependents(id: string): string[] {
    const seen = new Set<string>();
    const walk = (current: string): void =>
      (this.#options.graph.downstream.get(current) ?? [])
        .filter(dep => this.statuses.has(dep) && !seen.has(dep))
        .forEach(dep => {
          seen.add(dep);
          walk(dep);
        });
    walk(id);
    return [...seen];
  }

  /** Packages the update may take young: from the selected upstreams, or all upstreams. */
  #allowYoung(id: string): string[] {
    const upstreams = this.#options.ignoreReleaseAge
      ? (this.#options.graph.upstream.get(id) ?? [])
      : this.#selectedUpstreams(id);
    return [
      ...new Set(
        upstreams.flatMap(up => (this.#options.repos.get(up)?.published ?? []).map(pkg => pkg.name))
      ),
    ];
  }

  #tick(): void {
    [...this.statuses]
      .filter(([, status]) => status === 'queued')
      .forEach(([id]) => {
        const upstreams = this.#selectedUpstreams(id).map(up => this.statuses.get(up) ?? 'queued');
        if (upstreams.some(status => status === 'failed' || status === 'blocked')) {
          this.#set(id, 'blocked', 'an upstream repo failed');
        } else if (upstreams.every(status => SATISFIED.has(status))) {
          this.#launch(id);
        }
      });
    if (this.#running.size === 0 && this.#idle !== null) {
      this.#idle.resolve();
      this.#idle = null;
    }
  }

  #launch(id: string): void {
    const repo = this.#options.repos.get(id);
    if (repo === undefined || this.#running.has(id)) {
      return;
    }
    const run = this.#options.createRun(repo, this.#allowYoung(id));
    this.#running.set(id, run);
    // the run emits its own transitions; the scheduler only records the outcome
    this.statuses.set(id, 'preparing');
    void run
      .run()
      .catch((): RepoStatus => 'failed')
      .then(status => {
        this.#running.delete(id);
        this.statuses.set(id, status);
        this.#tick();
      });
  }
}
