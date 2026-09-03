// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
// Exercises the docker-bun feature end-to-end against a copied fixture, with the Bun release pinned
// on the context (see src/testing/module-context.factory) so no network call is made.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { BUN_LATEST, contextFor } from '../../../testing/module-context.factory.js';
import { withFixture } from '../../../testing/with-fixture.harness.js';
import { withTempDir } from '../../../testing/with-temp-dir.harness.js';
import { dockerBunFeature } from './docker-bun.feature.js';

describe('docker-bun feature', () => {
  test('aligns oven/bun:<ver> and BUN_VERSION= to the pinned Bun release', async () => {
    await withFixture('bun', async dir => {
      await dockerBunFeature.update(contextFor(dir));
      const dockerfile = await readFile(join(dir, 'Dockerfile'), 'utf8');
      assert.ok(dockerfile.includes(`oven/bun:${BUN_LATEST.version}-alpine`), 'FROM tag aligned');
      assert.ok(dockerfile.includes(`BUN_VERSION=${BUN_LATEST.version}`), 'BUN_VERSION aligned');
      assert.ok(!dockerfile.includes('1.1.30'), 'no stale version left behind');
    });
  });

  test('dry-run leaves the Dockerfile untouched', async () => {
    await withFixture('bun', async dir => {
      const before = await readFile(join(dir, 'Dockerfile'), 'utf8');
      await dockerBunFeature.update(contextFor(dir, true));
      assert.equal(await readFile(join(dir, 'Dockerfile'), 'utf8'), before);
    });
  });

  test('skips Dockerfiles under an excluded path', async () => {
    await withFixture('bun', async dir => {
      const nested = join(dir, 'examples', 'demo');
      await mkdir(nested, { recursive: true });
      const excludedFile = join(nested, 'Dockerfile');
      const before = await readFile(join(dir, 'Dockerfile'), 'utf8');
      await writeFile(excludedFile, before);

      await dockerBunFeature.update(contextFor(dir, false, ['examples']));

      assert.equal(await readFile(excludedFile, 'utf8'), before, 'excluded Dockerfile untouched');
      const root = await readFile(join(dir, 'Dockerfile'), 'utf8');
      assert.ok(root.includes(`BUN_VERSION=${BUN_LATEST.version}`), 'root Dockerfile aligned');
    });
  });

  test('owns the oven/bun image so the generic docker feature never bumps it', async () => {
    assert.deepEqual(await dockerBunFeature.managedImages?.(contextFor('/tmp')), ['oven/bun']);
  });

  test('applies only to Docker files that reference Bun', async () => {
    await withTempDir('docker-bun', async dir => {
      await writeFile(join(dir, 'Dockerfile'), 'FROM node:22\n');
      assert.equal(await dockerBunFeature.isUsed(contextFor(dir)), false, 'node-only file');
      await writeFile(join(dir, 'compose.yaml'), 'services:\n  app:\n    image: oven/bun:1.2\n');
      assert.equal(await dockerBunFeature.isUsed(contextFor(dir)), true, 'bun image present');
    });
  });

  test('config toggle forces the feature off even when a Bun Dockerfile is present', async () => {
    await withTempDir('docker-bun', async dir => {
      await writeFile(join(dir, 'Dockerfile'), 'FROM oven/bun:1.2\n');
      const base = contextFor(dir);
      const ctx = { ...base, config: { ...base.config, modules: { 'docker-bun': false } } };
      assert.equal(await dockerBunFeature.isUsed(ctx), false);
    });
  });

  test('config toggle forces the feature on even when no Docker files exist', async () => {
    await withTempDir('docker-bun', async dir => {
      const base = contextFor(dir);
      const ctx = { ...base, config: { ...base.config, modules: { 'docker-bun': true } } };
      assert.equal(await dockerBunFeature.isUsed(ctx), true);
    });
  });
});
