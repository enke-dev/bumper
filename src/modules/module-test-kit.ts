// Shared test harness for the module specs (node runtime + the file-rewriting features). Not a
// `.spec.ts`, so the test runners don't collect it; not reachable from `src/cli.ts`, so the
// bundler never ships it. Keeps each colocated spec free of a duplicated context/fixture setup.
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultRepoConfig } from '../config/config.js';
import type { ModuleContext, NodeLts } from '../context/context.types.js';
import { PackageManager, Runtime, VersionManager } from '../context/context.types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, '..', '..', 'examples');

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

/** Copy an example fixture into a throwaway tmp dir, run `fn`, then clean up. */
export async function withFixture(name: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `bumper-${name}-`));
  try {
    await cp(join(EXAMPLES, name), dir, { recursive: true });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
