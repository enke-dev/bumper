import type { ModuleContext } from '../context/context.types.js';
import { runStep } from '../utils/output.utils.js';
import { dockerImagesFeature } from './features/docker-images/docker-images.feature.js';
import { dockerNodeFeature } from './features/docker-node/docker-node.feature.js';
import { githubActionsFeature } from './features/github-actions/github-actions.feature.js';
import { typesNodeFeature } from './features/types-node/types-node.feature.js';
import type { Module } from './module.types.js';
import { bunPackageManager } from './package-managers/bun/bun.package-manager.js';
import { npmPackageManager } from './package-managers/npm/npm.package-manager.js';
import { pnpmPackageManager } from './package-managers/pnpm/pnpm.package-manager.js';
import { nodeRuntime } from './runtimes/node/node.runtime.js';

/**
 * Ordered module registry. Runtimes first so version pins are in place; then
 * dependency-pinning features (types-node) so their edits land in package.json *before*
 * the package manager installs — otherwise the lockfile would be left out of sync with a
 * freshly bumped `@types/node`. Package managers then bump + install everything, and the
 * remaining file-rewriting features run last.
 */
const MODULES: readonly Module[] = [
  nodeRuntime,
  typesNodeFeature,
  bunPackageManager,
  npmPackageManager,
  pnpmPackageManager,
  dockerNodeFeature,
  dockerImagesFeature,
  githubActionsFeature,
];

export interface ModuleStatus {
  id: string;
  title: string;
  used: boolean;
  /** `true` when `used` is forced by a `~/.bumperrc` toggle rather than auto-detection. */
  forced: boolean;
}

export interface RunOptions {
  only?: string[] | undefined;
  skip?: string[] | undefined;
}

/** Union of dependency names owned by every module that applies to this repo. */
export async function collectManagedDependencies(ctx: ModuleContext): Promise<Set<string>> {
  const owned = await Promise.all(
    MODULES.map(async module =>
      module.managedDependencies && (await module.isUsed(ctx))
        ? module.managedDependencies(ctx)
        : []
    )
  );
  return new Set(owned.flat());
}

/** Union of container image repos owned by every module that applies to this repo. */
export async function collectManagedImages(ctx: ModuleContext): Promise<Set<string>> {
  const owned = await Promise.all(
    MODULES.map(async module =>
      module.managedImages && (await module.isUsed(ctx)) ? module.managedImages(ctx) : []
    )
  );
  return new Set(owned.flat());
}

/** Generic update procedure: run every applicable module, in registry order. */
export async function runUpdate(ctx: ModuleContext, options: RunOptions = {}): Promise<void> {
  // resolve owned deps + images up front so the generic bumps can skip them, whatever the run order
  ctx.managedDependencies = await collectManagedDependencies(ctx);
  ctx.managedImages = await collectManagedImages(ctx);

  // reduce over a promise accumulator to keep modules strictly sequential (ordering
  // matters: runtimes pin versions before the features that read them)
  await MODULES.reduce(async (previous, module) => {
    await previous;
    if (options.only && !options.only.includes(module.id)) {
      return;
    }
    if (options.skip?.includes(module.id)) {
      return;
    }
    if (!(await module.isUsed(ctx))) {
      return;
    }
    await runStep(module.title, () => module.update(ctx));
  }, Promise.resolve());
}

/** Report per-module detection results (foundation for a CLI/GUI layer). */
export async function detectModules(ctx: ModuleContext): Promise<ModuleStatus[]> {
  return Promise.all(
    MODULES.map(async module => ({
      id: module.id,
      title: module.title,
      used: await module.isUsed(ctx),
      forced: ctx.config.modules[module.id] !== undefined,
    }))
  );
}
