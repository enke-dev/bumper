// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and
// `node --test`. Exercises the file-rewriting features end-to-end against a copied
// fixture, with the Node LTS pinned on the context so no network call is made.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { defaultRepoConfig } from '../config/config.js';
import type { ModuleContext, NodeLts } from '../context/context.types.js';
import { PackageManager, Runtime, VersionManager } from '../context/context.types.js';
import { readPackageJson } from '../utils/fs.utils.js';
import { dockerNodeFeature } from './features/docker-node/docker-node.feature.js';
import { updateTypesNode } from './features/types-node/types-node.feature.js';
import { nodeRuntime } from './runtimes/node/node.runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, '..', '..', 'examples');

/** Pinned LTS so update paths never touch the network (`ensureNodeLts` reads `ctx.nodeLts`). */
const LTS: NodeLts = { version: '22.15.1', major: 22 };

function contextFor(cwd: string, dryRun = false, exclude: string[] = []): ModuleContext {
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
async function withFixture(name: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `bumper-${name}-`));
  try {
    await cp(join(EXAMPLES, name), dir, { recursive: true });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('node runtime feature', () => {
  test('writes the LTS version to .node-version', async () => {
    await withFixture('node-npm', async dir => {
      await nodeRuntime.update(contextFor(dir));
      const written = await readFile(join(dir, '.node-version'), 'utf8');
      assert.equal(written, `v${LTS.version}\n`);
    });
  });

  test('dry-run leaves .node-version untouched', async () => {
    await withFixture('node-npm', async dir => {
      const before = await readFile(join(dir, '.node-version'), 'utf8');
      await nodeRuntime.update(contextFor(dir, true));
      const after = await readFile(join(dir, '.node-version'), 'utf8');
      assert.equal(after, before);
    });
  });
});

describe('types-node feature', () => {
  // Offline stub for the registry lookup: the newest @types/node in the LTS major line.
  const resolveInRange = async () => `${LTS.major}.9.3`;

  test('pins @types/node to the exact LTS-major version, preserving the range operator', async () => {
    await withFixture('node-npm', async dir => {
      await updateTypesNode(contextFor(dir), resolveInRange);
      const pkg = await readPackageJson(dir);
      // fixture spec is `^20.0.0` → caret preserved, pinned to the resolved full version.
      assert.equal(pkg?.devDependencies?.['@types/node'], `^${LTS.major}.9.3`);
    });
  });

  test('dry-run leaves the spec untouched', async () => {
    await withFixture('node-npm', async dir => {
      await updateTypesNode(contextFor(dir, true), resolveInRange);
      const pkg = await readPackageJson(dir);
      assert.equal(pkg?.devDependencies?.['@types/node'], '^20.0.0');
    });
  });
});

describe('docker-node feature', () => {
  test('aligns node:<ver> and NODE_VERSION= to the LTS version', async () => {
    await withFixture('node-npm', async dir => {
      await dockerNodeFeature.update(contextFor(dir));
      const dockerfile = await readFile(join(dir, 'Dockerfile'), 'utf8');
      assert.ok(dockerfile.includes(`node:${LTS.version}-alpine`), 'FROM image tag aligned');
      assert.ok(dockerfile.includes(`NODE_VERSION=${LTS.version}`), 'NODE_VERSION aligned');
      assert.ok(!dockerfile.includes('20.11.0'), 'no stale version left behind');
    });
  });

  test('dry-run leaves the Dockerfile untouched', async () => {
    await withFixture('node-npm', async dir => {
      const before = await readFile(join(dir, 'Dockerfile'), 'utf8');
      await dockerNodeFeature.update(contextFor(dir, true));
      const after = await readFile(join(dir, 'Dockerfile'), 'utf8');
      assert.equal(after, before);
    });
  });

  test('skips Dockerfiles under an excluded path', async () => {
    await withFixture('node-npm', async dir => {
      const nested = join(dir, 'examples', 'demo');
      await mkdir(nested, { recursive: true });
      const excludedFile = join(nested, 'Dockerfile');
      const before = await readFile(join(dir, 'Dockerfile'), 'utf8');
      await writeFile(excludedFile, before);

      await dockerNodeFeature.update(contextFor(dir, false, ['examples']));

      assert.equal(await readFile(excludedFile, 'utf8'), before, 'excluded Dockerfile untouched');
      const root = await readFile(join(dir, 'Dockerfile'), 'utf8');
      assert.ok(root.includes(`NODE_VERSION=${LTS.version}`), 'root Dockerfile still aligned');
    });
  });
});
