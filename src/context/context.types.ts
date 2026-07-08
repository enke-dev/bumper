import type { RepoConfig } from '../config/config.types.js';

/** JavaScript runtime a repo targets. */
export enum Runtime {
  Node = 'node',
  Bun = 'bun',
}

/** Package manager a repo uses. */
export enum PackageManager {
  Pnpm = 'pnpm',
  Npm = 'npm',
  Bun = 'bun',
}

/** Node version manager installed on the host (for LTS bumps). */
export enum VersionManager {
  Fnm = 'fnm',
  Asdf = 'asdf',
  Nvm = 'nvm',
  None = 'none',
}

/** Resolved latest Node LTS, shared across modules. */
export interface NodeLts {
  /** Full version, no leading `v`, e.g. `22.15.1`. */
  version: string;
  /** Major version, e.g. `22`. */
  major: number;
}

/**
 * Everything a {@link Module} needs to detect and act.
 * Built once per run by `buildContext()` from the detectors + resolved config.
 */
export interface ModuleContext {
  /** Absolute repo root. */
  cwd: string;
  runtime: Runtime;
  packageManager: PackageManager;
  isMonorepo: boolean;
  /** Absolute package dirs (repo root + workspace members), minus excludes. */
  workspaces: string[];
  /** Host version manager, `VersionManager.None` if none found. */
  versionManager: VersionManager;
  /** Latest Node LTS, resolved lazily before node-dependent modules run. */
  nodeLts?: NodeLts;
  /** Resolved per-repo config (excludes, module toggles). */
  config: RepoConfig;
  /**
   * Dependency names owned by the active modules; the generic bump skips them so each
   * owning module pins its own package. Populated by `runUpdate` before modules run.
   */
  managedDependencies?: ReadonlySet<string>;
  /** When true, modules print intended steps without mutating anything. */
  dryRun: boolean;
}
