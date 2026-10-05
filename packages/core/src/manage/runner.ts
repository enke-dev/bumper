import type { RepoConfig } from '../config/config.types.js';
import { PackageManager } from '../context/context.types.js';
import type { exec as execFn } from '../utils/exec.utils.js';
import { exec } from '../utils/exec.utils.js';
import { readPackageJson } from '../utils/fs.utils.js';
import { publishedVersions, viewTool } from '../utils/npm-registry.utils.js';
import type { EventSink, RepoStatus } from './events.js';
import type { StreamExec } from './exec-stream.js';
import { shellCommand, streamExec } from './exec-stream.js';
import type { Sleep, VersionsLookup, VersionSnapshot } from './release-wait.js';
import { sleep, snapshotVersions, waitForRelease } from './release-wait.js';
import type { RepoInfo } from './workspace.types.js';

const RUN_SCRIPT: Record<PackageManager, string[]> = {
  [PackageManager.Npm]: ['npm', 'run'],
  [PackageManager.Pnpm]: ['pnpm', 'run'],
  [PackageManager.Bun]: ['bun', 'run'],
};

/** Everything a run touches outside its own process; tests inject fakes. */
export interface RunnerDeps {
  stream: StreamExec;
  exec: typeof execFn;
  lookup: VersionsLookup;
  sleep: Sleep;
  now: () => number;
}

export const realDeps: RunnerDeps = {
  stream: streamExec,
  exec,
  lookup: (pkg, tool, cwd) => publishedVersions(pkg.name, tool, cwd, pkg.registry),
  sleep,
  now: Date.now,
};

export interface RepoRunOptions {
  repo: RepoInfo;
  config: RepoConfig;
  /** How to invoke bumper itself (`[execPath]` for the binary, `[execPath, script]` otherwise). */
  selfCommand: string[];
  /** Package names the update may take past the cooldown (the upstream repos' packages). */
  allowYoung: string[];
  /** How long to wait for the registry release before giving up. */
  waitTimeoutMs: number;
  emit: EventSink;
}

/** Thrown by a step to end the run as `failed` with a human reason. */
class StepFailure extends Error {}

/**
 * One repo's run: queued → preparing → updating → checking → pushing → awaiting-release → done,
 * or failed at any step. Every transition and output line goes to `emit`. The run owns a skip
 * signal for the release wait.
 */
export class RepoRun {
  status: RepoStatus = 'queued';
  detail: string | undefined;
  readonly #skip = new AbortController();
  readonly #deps: RunnerDeps;
  readonly #options: RepoRunOptions;

  constructor(options: RepoRunOptions, deps: RunnerDeps = realDeps) {
    this.#options = options;
    this.#deps = deps;
  }

  /** End an in-progress release wait early; dependents then consume whatever is published. */
  skipWaiting(): void {
    this.#skip.abort();
  }

  async run(): Promise<RepoStatus> {
    try {
      const target = await this.#prepare();
      const before = await this.#snapshot();
      const changed = await this.#update();
      if (!changed) {
        return this.#finish('done', 'nothing to update');
      }
      await this.#check();
      await this.#push(target);
      return this.#awaitRelease(before);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log('system', message);
      return this.#finish('failed', message);
    }
  }

  get #repo(): RepoInfo {
    return this.#options.repo;
  }

  #log(stream: 'stdout' | 'stderr' | 'system', line: string): void {
    this.#options.emit({ type: 'log', repo: this.#repo.id, stream, line, at: this.#deps.now() });
  }

  #transition(status: RepoStatus, detail?: string): void {
    this.status = status;
    this.detail = detail;
    this.#options.emit({
      type: 'status',
      repo: this.#repo.id,
      status,
      ...(detail !== undefined ? { detail } : {}),
      at: this.#deps.now(),
    });
  }

  #finish(status: RepoStatus, detail: string): RepoStatus {
    this.#transition(status, detail);
    return status;
  }

  /** Run a command, streaming its output to the log; throws a {@link StepFailure} on failure. */
  async #run(cmd: string[], failure: string, env?: Record<string, string>): Promise<void> {
    this.#log('system', `$ ${cmd.join(' ')}`);
    const code = await this.#deps.stream(cmd, {
      cwd: this.#repo.path,
      ...(env ? { env } : {}),
      onLine: (stream, line) => this.#log(stream, line),
    });
    if (code !== 0) {
      throw new StepFailure(`${failure} (exit ${code})`);
    }
  }

  /** Quiet query (no log), returning stdout or null on a non-zero exit. */
  async #query(cmd: string[]): Promise<string | null> {
    const { exitCode, stdout } = await this.#deps.exec(cmd, { cwd: this.#repo.path });
    return exitCode === 0 ? stdout.trim() : null;
  }

  /** Clean tree, fetch, switch to the configured branch, fast-forward. Returns the branch. */
  async #prepare(): Promise<string> {
    this.#transition('preparing');
    if (this.#repo.packageManager === null) {
      throw new StepFailure(this.#repo.unsupported ?? 'unsupported repository');
    }
    const dirty = await this.#query(['git', 'status', '--porcelain']);
    if (dirty === null) {
      throw new StepFailure('not a git work tree');
    }
    if (dirty !== '') {
      throw new StepFailure('work tree has uncommitted changes');
    }
    await this.#run(['git', 'fetch', '--quiet'], 'git fetch failed');
    const current = await this.#query(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
    const target = this.#options.config.branch ?? current;
    if (target === null || target === 'HEAD') {
      throw new StepFailure('detached HEAD and no branch configured');
    }
    if (target !== current) {
      await this.#switchTo(target);
    }
    if ((await this.#query(['git', 'rev-parse', '--abbrev-ref', '@{upstream}'])) !== null) {
      await this.#run(['git', 'pull', '--ff-only', '--quiet'], 'git pull --ff-only failed');
    }
    return target;
  }

  /** Check out an existing local branch, track an existing remote one, or create it from HEAD. */
  async #switchTo(branch: string): Promise<void> {
    if (
      (await this.#query(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) !==
      null
    ) {
      await this.#run(['git', 'checkout', '--quiet', branch], `checkout of ${branch} failed`);
      return;
    }
    const remote = `refs/remotes/origin/${branch}`;
    if ((await this.#query(['git', 'rev-parse', '--verify', '--quiet', remote])) !== null) {
      await this.#run(
        ['git', 'checkout', '--quiet', '--track', '-b', branch, `origin/${branch}`],
        `checkout of ${branch} failed`
      );
      return;
    }
    this.#log('system', `creating branch ${branch} from the current one`);
    await this.#run(['git', 'checkout', '--quiet', '-b', branch], `creating ${branch} failed`);
  }

  #waits(): boolean {
    const { repo, config } = this.#options;
    return config.waitForRelease && !repo.private && repo.published.length > 0;
  }

  async #snapshot(): Promise<VersionSnapshot> {
    const pm = this.#repo.packageManager ?? PackageManager.Npm;
    return this.#waits()
      ? snapshotVersions(this.#repo.published, viewTool(pm), this.#repo.path, this.#deps.lookup)
      : new Map();
  }

  /** `bumper update -afc`; true when it produced a commit. */
  async #update(): Promise<boolean> {
    this.#transition('updating');
    const head = await this.#query(['git', 'rev-parse', 'HEAD']);
    const allow = this.#options.allowYoung.flatMap(name => ['--allow-young', name]);
    await this.#run(
      [...this.#options.selfCommand, 'update', '--approve', '--format', '--commit', ...allow],
      'bumper update failed',
      { FORCE_COLOR: '1' }
    );
    return (await this.#query(['git', 'rev-parse', 'HEAD'])) !== head;
  }

  /** The configured checks in order: a script name through the package manager, else the shell. */
  async #check(): Promise<void> {
    const { config, repo } = this.#options;
    if (config.checks.length === 0) {
      return;
    }
    this.#transition('checking');
    const scripts = (await readPackageJson(repo.path))?.scripts ?? {};
    const pm = repo.packageManager ?? PackageManager.Npm;
    await config.checks.reduce(async (previous, check) => {
      await previous;
      const cmd = check in scripts ? [...RUN_SCRIPT[pm], check] : shellCommand(check);
      await this.#run(cmd, `check "${check}" failed`);
    }, Promise.resolve());
  }

  async #push(branch: string): Promise<void> {
    this.#transition('pushing');
    await this.#run(
      ['git', 'push', '--quiet', '--set-upstream', 'origin', branch],
      'git push failed'
    );
  }

  async #awaitRelease(before: VersionSnapshot): Promise<RepoStatus> {
    if (!this.#waits()) {
      return this.#finish('done', 'pushed');
    }
    this.#transition('awaiting-release');
    const pm = this.#repo.packageManager ?? PackageManager.Npm;
    const result = await waitForRelease({
      packages: this.#repo.published,
      tool: viewTool(pm),
      cwd: this.#repo.path,
      before,
      lookup: this.#deps.lookup,
      timeoutMs: this.#options.waitTimeoutMs,
      signal: this.#skip.signal,
      sleep: this.#deps.sleep,
      now: this.#deps.now,
      onPoll: pending =>
        pending.length > 0 && this.#log('system', `waiting for release of ${pending.join(', ')}`),
    });
    switch (result.outcome) {
      case 'released':
        return this.#finish(
          'done',
          `released ${Object.entries(result.versions)
            .map(([name, version]) => `${name}@${version}`)
            .join(', ')}`
        );
      case 'skipped':
        return this.#finish('done', 'pushed; release wait skipped');
      case 'timeout':
        return this.#finish(
          'failed',
          `no new version of ${result.pending.join(', ')} within ${Math.round(this.#options.waitTimeoutMs / 60_000)} min`
        );
    }
  }
}
