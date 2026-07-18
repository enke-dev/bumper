import { defaultRepoConfig, resolveForPath } from '../config/config.js';
import { isExcluded } from '../utils/fs.utils.js';
import type { ModuleContext } from './context.types.js';
import { detectPackageManager } from './detectors/package-manager.detector.js';
import { detectRuntime } from './detectors/runtime.detector.js';
import { detectVersionManager } from './detectors/version-manager.detector.js';
import { detectWorkspaces } from './detectors/workspace.detector.js';

export interface BuildContextOptions {
  dryRun?: boolean;
  /** Extra excludes (e.g. from `--exclude`), merged with the persisted list for this run only. */
  exclude?: string[];
  /** Skip reading/writing `~/.bumperrc` entirely; run with pure auto-detection. */
  ignoreConfig?: boolean;
}

/** Run all detectors + resolve config into a single {@link ModuleContext}. */
export async function buildContext(
  cwd: string,
  options: BuildContextOptions = {}
): Promise<{ ctx: ModuleContext; configCreated: boolean }> {
  const { config: stored, created } = options.ignoreConfig
    ? { config: defaultRepoConfig(), created: false }
    : await resolveForPath(cwd);
  // fold ephemeral CLI excludes into the persisted list; every exclude consumer (workspace
  // filter + file-based features via ctx.config) then sees one merged list, nothing is saved.
  const exclude = [...new Set([...stored.exclude, ...(options.exclude ?? [])])];
  const config = { ...stored, exclude };
  const [runtime, packageManager] = await Promise.all([
    detectRuntime(cwd),
    detectPackageManager(cwd),
  ]);
  const { isMonorepo, workspaces } = await detectWorkspaces(cwd, packageManager);
  const versionManager = detectVersionManager();

  const ctx: ModuleContext = {
    cwd,
    runtime,
    packageManager,
    isMonorepo,
    workspaces: workspaces.filter(dir => !isExcluded(cwd, dir, exclude)),
    versionManager,
    config,
    dryRun: options.dryRun ?? false,
  };
  return { ctx, configCreated: created };
}
