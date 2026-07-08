import { relative } from 'node:path';

import { resolveForPath } from '../config/config.js';
import type { ModuleContext } from './context.types.js';
import { detectPackageManager } from './detectors/package-manager.detector.js';
import { detectRuntime } from './detectors/runtime.detector.js';
import { detectVersionManager } from './detectors/version-manager.detector.js';
import { detectWorkspaces } from './detectors/workspace.detector.js';

export interface BuildContextOptions {
  dryRun?: boolean;
}

/** Whether a workspace dir is excluded by any repo-relative exclude entry. */
function isExcluded(cwd: string, dir: string, exclude: string[]): boolean {
  const rel = relative(cwd, dir);
  return exclude.some(entry => rel === entry || rel.startsWith(`${entry}/`));
}

/** Run all detectors + resolve config into a single {@link ModuleContext}. */
export async function buildContext(
  cwd: string,
  options: BuildContextOptions = {}
): Promise<{ ctx: ModuleContext; configCreated: boolean }> {
  const { config, created } = await resolveForPath(cwd);
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
    workspaces: workspaces.filter(dir => !isExcluded(cwd, dir, config.exclude)),
    versionManager,
    config,
    dryRun: options.dryRun ?? false,
  };
  return { ctx, configCreated: created };
}
