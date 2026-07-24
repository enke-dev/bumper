// Builds a ModuleContext for the module specs (node runtime + the file-rewriting features), with
// the Node LTS pinned so update paths never touch the network. Lives under src/testing/ (not a
// `*.spec.ts`, so the test runners don't collect it; unreachable from src/cli.ts, so the bundler
// never ships it) to keep each colocated spec free of a duplicated context setup.
import { defaultRepoConfig } from '../config/config.js';
import type { ModuleContext, NodeLts } from '../context/context.types.js';
import { PackageManager, Runtime, VersionManager } from '../context/context.types.js';

/** Pinned LTS so update paths never touch the network (`ensureNodeLts` reads `ctx.nodeLts`). */
export const LTS: NodeLts = { version: '22.15.1', major: 22 };

export function contextFor(cwd: string, dryRun = false, exclude: string[] = []): ModuleContext {
  return {
    cwd,
    runtime: Runtime.Node,
    packageManager: PackageManager.Npm,
    isMonorepo: false,
    workspaces: [cwd],
    versionManager: VersionManager.None,
    nodeLts: { ...LTS },
    config: { ...defaultRepoConfig(), exclude },
    dryRun,
  };
}
