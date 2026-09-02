// Builds a ModuleContext for the module specs (runtimes + the file-rewriting features), with the
// Node LTS and the Bun release pinned so update paths never touch the network. Lives under src/testing/ (not a
// `*.spec.ts`, so the test runners don't collect it; unreachable from src/cli.ts, so the bundler
// never ships it) to keep each colocated spec free of a duplicated context setup.
import { defaultRepoConfig } from '../config/config.js';
import type { BunRelease, ModuleContext, NodeLts } from '../context/context.types.js';
import { PackageManager, Runtime, VersionManager } from '../context/context.types.js';

/** Pinned Node LTS so update paths never touch the network (`ensureNodeLts` reads `ctx.nodeLts`). */
export const NODE_LTS: NodeLts = { version: '22.15.1', major: 22 };
/** Pinned Bun latest release so update paths never touch the network (`ensureBunLatest` reads
 * `ctx.bunLatest`). */
export const BUN_LATEST: BunRelease = { version: '1.3.0', major: 1 };

export function contextFor(cwd: string, dryRun = false, exclude: string[] = []): ModuleContext {
  return {
    cwd,
    runtime: Runtime.Node,
    packageManager: PackageManager.Npm,
    isMonorepo: false,
    workspaces: [cwd],
    versionManager: VersionManager.None,
    nodeLts: { ...NODE_LTS },
    bunLatest: { ...BUN_LATEST },
    config: { ...defaultRepoConfig(), exclude },
    dryRun,
  };
}
