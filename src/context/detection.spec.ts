// Runtime-agnostic test: uses only `node:test` + `node:assert`, so it runs unchanged under
// both `bun test` and `node --test`. The whole suite follows this `.spec.ts` convention —
// no `bun:` imports in tests or source — so both runtimes exercise identical code paths.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { defaultRepoConfig } from '../config/config.js';
import { detectModules } from '../modules/module.registry.js';
import type { ModuleContext } from './context.types.js';
import { PackageManager, Runtime, VersionManager } from './context.types.js';
import { detectPackageManager } from './detectors/package-manager.detector.js';
import { detectRuntime } from './detectors/runtime.detector.js';
import { detectWorkspaces } from './detectors/workspace.detector.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, '..', '..', 'examples');

/**
 * Build a context straight from the detectors — deliberately NOT via `buildContext`,
 * which would persist a `~/.bumperrc` entry as a side effect. Version manager is pinned
 * to `None` so results don't depend on what's installed on the host.
 */
async function detect(dir: string): Promise<{ ctx: ModuleContext; used: Set<string> }> {
  const cwd = join(EXAMPLES, dir);
  const [runtime, packageManager] = await Promise.all([
    detectRuntime(cwd),
    detectPackageManager(cwd),
  ]);
  const { isMonorepo, workspaces } = await detectWorkspaces(cwd, packageManager);
  const ctx: ModuleContext = {
    cwd,
    runtime,
    packageManager,
    isMonorepo,
    workspaces,
    versionManager: VersionManager.None,
    config: defaultRepoConfig(),
    dryRun: false,
  };
  const modules = await detectModules(ctx);
  const used = new Set(modules.filter(m => m.used).map(m => m.id));
  return { ctx, used };
}

describe('detection: node + npm', () => {
  test('runtime, package manager and applicable modules', async () => {
    const { ctx, used } = await detect('node-npm');
    assert.equal(ctx.runtime, Runtime.Node);
    assert.equal(ctx.packageManager, PackageManager.Npm);
    assert.equal(ctx.isMonorepo, false);
    assert.deepEqual([...used].sort(), ['docker', 'github-actions', 'node', 'npm', 'types-node']);
  });
});

describe('detection: node + pnpm', () => {
  test('runtime, package manager and applicable modules', async () => {
    const { ctx, used } = await detect('node-pnpm');
    assert.equal(ctx.runtime, Runtime.Node);
    assert.equal(ctx.packageManager, PackageManager.Pnpm);
    assert.equal(ctx.isMonorepo, false);
    assert.deepEqual([...used].sort(), ['node', 'pnpm', 'types-node']);
    assert.ok(!used.has('npm'));
    assert.ok(!used.has('bun'));
  });
});

describe('detection: bun', () => {
  test('bun runtime + package manager win over node', async () => {
    const { ctx, used } = await detect('bun');
    assert.equal(ctx.runtime, Runtime.Bun);
    assert.equal(ctx.packageManager, PackageManager.Bun);
    assert.ok(used.has('bun'));
    assert.ok(used.has('types-node'), '@types/node is present so types-node applies');
    // no .node-version and a bun runtime → the node runtime module stays off
    assert.ok(!used.has('node'));
    assert.ok(!used.has('npm'));
    assert.ok(!used.has('pnpm'));
  });
});

describe('detection: pnpm monorepo', () => {
  test('expands workspace globs and flags applicable modules', async () => {
    const { ctx, used } = await detect('pnpm-monorepo');
    assert.equal(ctx.runtime, Runtime.Node);
    assert.equal(ctx.packageManager, PackageManager.Pnpm);
    assert.equal(ctx.isMonorepo, true);
    // root + packages/a + packages/b
    assert.equal(ctx.workspaces.length, 3);
    assert.ok(ctx.workspaces.some(w => w.endsWith(join('packages', 'a'))));
    assert.ok(ctx.workspaces.some(w => w.endsWith(join('packages', 'b'))));
    // only packages/a declares @types/node, but that's enough to enable the feature
    assert.ok(used.has('types-node'));
    assert.ok(used.has('pnpm'));
  });
});
