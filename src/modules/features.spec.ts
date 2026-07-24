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
import { pathExists, readPackageJson } from '../utils/fs.utils.js';
import {
  dockerImagesFeature,
  updateDockerImages,
} from './features/docker-images/docker-images.feature.js';
import type { ImageRef } from './features/docker-images/docker-refs.utils.js';
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

  test('updates an existing .nvmrc but never creates one', async () => {
    await withFixture('node-npm', async dir => {
      // fixture ships no .nvmrc → the root stays free of a redundant dotfile
      await nodeRuntime.update(contextFor(dir));
      assert.equal(await pathExists(join(dir, '.nvmrc')), false, 'no .nvmrc imposed');

      // a repo that keeps one gets it aligned
      await writeFile(join(dir, '.nvmrc'), 'v18.0.0\n');
      await nodeRuntime.update(contextFor(dir));
      assert.equal(await readFile(join(dir, '.nvmrc'), 'utf8'), `v${LTS.version}\n`);
    });
  });

  test('aligns an existing engines.node floor, preserving its operator', async () => {
    await withFixture('node-npm', async dir => {
      // fixture declares `>=20` → major-granular, operator preserved
      await nodeRuntime.update(contextFor(dir));
      const pkg = await readPackageJson(dir);
      assert.equal(pkg?.engines?.['node'], `>=${LTS.major}`);
    });
  });

  test('dry-run leaves .node-version, .nvmrc and engines.node untouched', async () => {
    await withFixture('node-npm', async dir => {
      await writeFile(join(dir, '.nvmrc'), 'v18.0.0\n');
      const beforeVersion = await readFile(join(dir, '.node-version'), 'utf8');
      const beforeNvmrc = await readFile(join(dir, '.nvmrc'), 'utf8');
      const beforePkg = await readPackageJson(dir);
      await nodeRuntime.update(contextFor(dir, true));
      assert.equal(await readFile(join(dir, '.node-version'), 'utf8'), beforeVersion);
      assert.equal(await readFile(join(dir, '.nvmrc'), 'utf8'), beforeNvmrc);
      const afterPkg = await readPackageJson(dir);
      assert.equal(afterPkg?.engines?.['node'], beforePkg?.engines?.['node']);
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

  test('owns the node image so the generic docker feature never bumps it', async () => {
    assert.deepEqual(await dockerNodeFeature.managedImages?.(contextFor('/tmp')), ['node']);
  });
});

describe('docker-images feature', () => {
  // Offline tag lookup keyed off the parsed ref; the node image must never be queried (owned by
  // docker-node). GHCR is reached the same way (routing to the OCI client is the default fetcher's
  // job — exercised in oci-registry.client.spec).
  const fetchTags = async (ref: ImageRef): Promise<string[]> => {
    if (ref.name === 'node') {
      throw new Error('owned image must not be queried');
    }
    if (ref.name === 'postgres') {
      return ['16', '17', '18', '18.3'];
    }
    if (ref.name === 'redis') {
      return ['7.2', '7.4', '8.0'];
    }
    return [];
  };

  async function withDockerfile(
    body: string,
    run: (dir: string, ctx: ModuleContext) => Promise<void>,
    dryRun = false
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'bumper-docker-'));
    try {
      await writeFile(join(dir, 'Dockerfile'), body);
      const ctx: ModuleContext = { ...contextFor(dir, dryRun), managedImages: new Set(['node']) };
      await run(dir, ctx);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('detects a repo with Docker/compose files', async () => {
    await withFixture('node-npm', async dir => {
      assert.equal(await dockerImagesFeature.isUsed(contextFor(dir)), true);
    });
  });

  test('bumps a Hub image to the newest same-shape tag, skipping the owned node image', async () => {
    await withDockerfile('FROM node:20-alpine\nFROM postgres:16\n', async (dir, ctx) => {
      await updateDockerImages(ctx, fetchTags);
      const out = await readFile(join(dir, 'Dockerfile'), 'utf8');
      assert.ok(out.includes('FROM postgres:18'), 'postgres bumped to newest bare major');
      assert.ok(out.includes('FROM node:20-alpine'), 'owned node image left untouched');
    });
  });

  test('preserves precision + variant when picking the newer tag', async () => {
    await withDockerfile('FROM redis:7.2\n', async (dir, ctx) => {
      await updateDockerImages(ctx, fetchTags);
      // 7.2 is major.minor → newest major.minor is 8.0 (not the bare-major 8)
      assert.ok((await readFile(join(dir, 'Dockerfile'), 'utf8')).includes('FROM redis:8.0'));
    });
  });

  test('bumps a non-Hub (ghcr) image the same way', async () => {
    await withDockerfile('FROM ghcr.io/x/redis:7.2\n', async (dir, ctx) => {
      await updateDockerImages(ctx, fetchTags);
      assert.ok(
        (await readFile(join(dir, 'Dockerfile'), 'utf8')).includes('FROM ghcr.io/x/redis:8.0')
      );
    });
  });

  test('leaves digest-pinned, untagged and non-numeric refs untouched', async () => {
    const body = 'FROM redis:latest\nFROM postgres\nFROM postgres:16@sha256:abc\n';
    await withDockerfile(body, async (dir, ctx) => {
      await updateDockerImages(ctx, fetchTags);
      assert.equal(await readFile(join(dir, 'Dockerfile'), 'utf8'), body);
    });
  });

  test('dry-run rewrites nothing', async () => {
    await withDockerfile(
      'FROM postgres:16\n',
      async (dir, ctx) => {
        await updateDockerImages(ctx, fetchTags);
        assert.equal(await readFile(join(dir, 'Dockerfile'), 'utf8'), 'FROM postgres:16\n');
      },
      true
    );
  });
});
