// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
// Exercises the docker-node feature end-to-end against a copied fixture, with the Node LTS pinned
// on the context (see src/testing/module-context.factory) so no network call is made.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { contextFor, LTS } from '../../../testing/module-context.factory.js';
import { withFixture } from '../../../testing/with-fixture.harness.js';
import { withTempDir } from '../../../testing/with-temp-dir.harness.js';
import { dockerNodeFeature } from './docker-node.feature.js';

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

  // Presence/absence is covered cross-feature in detection.spec; the config toggle override is not
  // exercised elsewhere, so pin both directions of it here (mirrors the docker-images feature).
  test('config toggle forces the feature off even when a Dockerfile is present', async () => {
    await withTempDir('docker-node', async dir => {
      await writeFile(join(dir, 'Dockerfile'), 'FROM node:20\n');
      const base = contextFor(dir);
      const ctx = { ...base, config: { ...base.config, modules: { 'docker-node': false } } };
      assert.equal(await dockerNodeFeature.isUsed(ctx), false);
    });
  });

  test('config toggle forces the feature on even when no Docker files exist', async () => {
    await withTempDir('docker-node', async dir => {
      const base = contextFor(dir);
      const ctx = { ...base, config: { ...base.config, modules: { 'docker-node': true } } };
      assert.equal(await dockerNodeFeature.isUsed(ctx), true);
    });
  });
});
