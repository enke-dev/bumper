import type { RepoConfig } from '../config/config.types.js';
import type { exec } from '../utils/exec.utils.js';
import { isAuthFailure, viewTool } from '../utils/npm-registry.utils.js';
import type { RepoGraph } from './graph.js';
import type { RepoInfo } from './workspace.types.js';

export type Severity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  /** Stable machine id (`dirty-tree`, `graph-cycle`, …) the UI keys icons/filters on. */
  code: string;
  severity: Severity;
  message: string;
}

export interface DiagnosticContext {
  repo: RepoInfo;
  graph: RepoGraph;
  config: RepoConfig;
  run: typeof exec;
}

/** One check. Returns nothing when it has nothing to say. Add a collector = add a diagnostic. */
export type DiagnosticCollector = (ctx: DiagnosticContext) => Promise<Diagnostic[]> | Diagnostic[];

export const unsupportedRepo: DiagnosticCollector = ({ repo }) =>
  repo.unsupported ? [{ code: 'unsupported', severity: 'error', message: repo.unsupported }] : [];

export const noChecksConfigured: DiagnosticCollector = ({ repo, config }) =>
  repo.packageManager !== null && config.checks.length === 0
    ? [
        {
          code: 'no-checks',
          severity: 'info',
          message: 'no checks configured: the update is pushed untested',
        },
      ]
    : [];

export const graphCycle: DiagnosticCollector = ({ repo, graph }) =>
  graph.cycles
    .filter(cycle => cycle.includes(repo.id))
    .map(cycle => ({
      code: 'graph-cycle',
      severity: 'warning' as const,
      message: `dependency cycle with ${cycle.filter(id => id !== repo.id).join(', ')}`,
    }));

export const ambiguousProducer: DiagnosticCollector = ({ repo, graph }) =>
  graph.ambiguous
    .filter(entry => entry.repos.includes(repo.id))
    .map(entry => ({
      code: 'ambiguous-producer',
      severity: 'warning' as const,
      message: `${entry.name} is also published by ${entry.repos.filter(id => id !== repo.id).join(', ')}; no dependency edge derived`,
    }));

export const dirtyTree: DiagnosticCollector = async ({ repo, run }) => {
  const { exitCode, stdout } = await run(['git', 'status', '--porcelain'], { cwd: repo.path });
  return exitCode === 0 && stdout.trim() !== ''
    ? [{ code: 'dirty-tree', severity: 'error', message: 'uncommitted changes in the work tree' }]
    : [];
};

/** Compares against the already-fetched tracking ref; no network. */
export const behindRemote: DiagnosticCollector = async ({ repo, run }) => {
  const { exitCode, stdout } = await run(['git', 'rev-list', '--count', 'HEAD..@{upstream}'], {
    cwd: repo.path,
  });
  const behind = Number(stdout.trim());
  return exitCode === 0 && behind > 0
    ? [
        {
          code: 'behind-remote',
          severity: 'warning',
          message: `${behind} commit(s) behind upstream`,
        },
      ]
    : [];
};

/** The repo is on another branch than the one it is configured to push. */
export const branchMismatch: DiagnosticCollector = ({ repo, config }) =>
  config.branch !== undefined && repo.branch !== null && config.branch !== repo.branch
    ? [
        {
          code: 'branch-switch',
          severity: 'info',
          message: `on ${repo.branch}; the run switches to ${config.branch}`,
        },
      ]
    : [];

/** A `view` of the first published package must not be refused for credentials. */
export const registryAuth: DiagnosticCollector = async ({ repo, config, run }) => {
  const [pkg] = repo.published;
  if (!pkg || repo.private || !config.waitForRelease || repo.packageManager === null) {
    return [];
  }
  const tool = viewTool(repo.packageManager);
  const { exitCode, stdout, stderr } = await run(
    [tool, 'view', pkg.name, 'version', ...(pkg.registry ? ['--registry', pkg.registry] : [])],
    { cwd: repo.path }
  );
  return exitCode !== 0 && isAuthFailure(`${stdout}\n${stderr}`)
    ? [
        {
          code: 'registry-auth',
          severity: 'error',
          message: `no credentials for ${pkg.registry ?? 'the registry'} (${pkg.name}); the release wait would never see a version`,
        },
      ]
    : [];
};

export const DEFAULT_COLLECTORS: readonly DiagnosticCollector[] = [
  unsupportedRepo,
  noChecksConfigured,
  graphCycle,
  ambiguousProducer,
  branchMismatch,
  dirtyTree,
  behindRemote,
  registryAuth,
];

export async function collectDiagnostics(
  ctx: DiagnosticContext,
  collectors: readonly DiagnosticCollector[] = DEFAULT_COLLECTORS
): Promise<Diagnostic[]> {
  const results = await Promise.all(collectors.map(collector => collector(ctx)));
  return results.flat();
}
