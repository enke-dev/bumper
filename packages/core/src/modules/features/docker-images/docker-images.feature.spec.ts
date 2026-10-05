// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
// Exercises the docker-images feature end-to-end against throwaway tmp files, with the tag/digest
// lookups injected (see src/testing for the shared context) so no network call is made.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { ModuleContext } from '../../../context/context.types.js';
import { contextFor } from '../../../testing/module-context.factory.js';
import { withFixture } from '../../../testing/with-fixture.harness.js';
import { withTempDir } from '../../../testing/with-temp-dir.harness.js';
import type { ImageRef } from '../../../utils/docker.utils.js';
import { dockerImagesFeature, updateDockerImages } from './docker-images.feature.js';

describe('docker-images feature', () => {
  // Offline tag lookup keyed off the parsed ref; the node image must never be queried (owned by
  // docker-node). GHCR is reached the same way (routing to the OCI client is the default fetcher's
  // job — exercised in oci-registry.client.spec).
  const fetchTags = async (ref: ImageRef): Promise<string[]> => {
    if (ref.repository.endsWith('/node')) {
      throw new Error('owned image must not be queried');
    }
    if (ref.repository.endsWith('/postgres')) {
      return ['16', '17', '18', '18.3'];
    }
    if (ref.repository.endsWith('/redis')) {
      return ['7.2', '7.4', '8.0'];
    }
    return [];
  };

  function withDockerfile(
    body: string,
    run: (dir: string, ctx: ModuleContext) => Promise<void>,
    dryRun = false
  ): Promise<void> {
    return withTempDir('docker', async dir => {
      await writeFile(join(dir, 'Dockerfile'), body);
      const ctx: ModuleContext = { ...contextFor(dir, dryRun), managedImages: new Set(['node']) };
      await run(dir, ctx);
    });
  }

  /** Like {@link withDockerfile} but writes an arbitrary set of `{ name: contents }` files. */
  function withFiles(
    files: Record<string, string>,
    run: (dir: string, ctx: ModuleContext) => Promise<void>
  ): Promise<void> {
    return withTempDir('docker', async dir => {
      await Promise.all(
        Object.entries(files).map(([name, body]) => writeFile(join(dir, name), body))
      );
      const ctx: ModuleContext = { ...contextFor(dir), managedImages: new Set(['node']) };
      await run(dir, ctx);
    });
  }

  test('detects a repo with Docker/compose files', async () => {
    await withFixture('node-npm', async dir => {
      assert.equal(await dockerImagesFeature.isUsed(contextFor(dir)), true);
    });
  });

  // The presence/absence branches of isUsed are covered cross-feature in detection.spec; the config
  // toggle override is not exercised anywhere else, so pin both directions of it here.
  test('config toggle forces the feature off even when a Dockerfile is present', async () => {
    await withTempDir('docker', async dir => {
      await writeFile(join(dir, 'Dockerfile'), 'FROM postgres:16\n');
      const base = contextFor(dir);
      const ctx = { ...base, config: { ...base.config, modules: { 'docker-images': false } } };
      assert.equal(await dockerImagesFeature.isUsed(ctx), false);
    });
  });

  test('config toggle forces the feature on even when no Docker files exist', async () => {
    await withTempDir('docker', async dir => {
      const base = contextFor(dir);
      const ctx = { ...base, config: { ...base.config, modules: { 'docker-images': true } } };
      assert.equal(await dockerImagesFeature.isUsed(ctx), true);
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

  test('repins a digest-pinned ref: bumps the tag AND re-resolves the digest', async () => {
    const old = `sha256:${'a'.repeat(64)}`;
    const fresh = `sha256:${'b'.repeat(64)}`;
    const resolveDigest = async (_ref: ImageRef, tag: string) => (tag === '18' ? fresh : null);
    await withDockerfile(`FROM postgres:16@${old}\n`, async (dir, ctx) => {
      await updateDockerImages(ctx, fetchTags, resolveDigest);
      assert.equal(await readFile(join(dir, 'Dockerfile'), 'utf8'), `FROM postgres:18@${fresh}\n`);
    });
  });

  test('leaves a digest-pinned ref alone when the new digest cannot be resolved', async () => {
    const body = `FROM postgres:16@sha256:${'a'.repeat(64)}\n`;
    const resolveDigest = async () => null;
    await withDockerfile(body, async (dir, ctx) => {
      await updateDockerImages(ctx, fetchTags, resolveDigest);
      assert.equal(await readFile(join(dir, 'Dockerfile'), 'utf8'), body);
    });
  });

  test('leaves bare-digest, untagged and non-numeric refs untouched', async () => {
    const body = `FROM redis:latest\nFROM postgres\nFROM postgres@sha256:${'a'.repeat(64)}\n`;
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

  test('matches the ref as a whole token, never a substring of a longer ref', async () => {
    // `postgres:16` shares a prefix with `postgres:16-alpine`, and `node:20` is a suffix of the
    // (unmanaged, so bumpable) `mynode:20`. Only the exact token must be rewritten.
    const body =
      'FROM postgres:16\n' + 'FROM postgres:16-alpine\n' + 'FROM mynode:20\n' + 'FROM node:20\n';
    await withDockerfile(body, async (dir, ctx) => {
      await updateDockerImages(ctx, fetchTags);
      const out = await readFile(join(dir, 'Dockerfile'), 'utf8');
      // postgres:16 → 18, but postgres:16-alpine untouched (no alpine tags in the stub)
      assert.ok(out.includes('FROM postgres:18\n'), 'bare postgres:16 bumped');
      assert.ok(out.includes('FROM postgres:16-alpine\n'), 'the -alpine sibling left intact');
      // mynode is not the owned `node` image (different repo) and has no tags → left as written,
      // and must not have been mangled while the owned `node:20` was skipped.
      assert.ok(out.includes('FROM mynode:20\n'), 'mynode:20 not touched as a node:20 substring');
      assert.ok(out.includes('FROM node:20\n'), 'owned node:20 skipped');
    });
  });

  test('bumps compose `image:` refs, not just Dockerfile FROM', async () => {
    const body = 'services:\n  db:\n    image: postgres:16\n  cache:\n    image: "redis:7.2"\n';
    await withFiles({ 'docker-compose.yaml': body }, async (dir, ctx) => {
      await updateDockerImages(ctx, fetchTags);
      const out = await readFile(join(dir, 'docker-compose.yaml'), 'utf8');
      assert.ok(out.includes('image: postgres:18'), 'unquoted compose ref bumped');
      assert.ok(out.includes('redis:8.0'), 'quoted compose ref bumped');
    });
  });

  test('rewrites every occurrence of a repeated ref', async () => {
    const body = 'FROM postgres:16 AS base\nFROM postgres:16 AS worker\n';
    await withDockerfile(body, async (dir, ctx) => {
      await updateDockerImages(ctx, fetchTags);
      const out = await readFile(join(dir, 'Dockerfile'), 'utf8');
      assert.equal(out, 'FROM postgres:18 AS base\nFROM postgres:18 AS worker\n');
    });
  });

  test('updates multiple docker files independently in one run', async () => {
    await withFiles(
      {
        Dockerfile: 'FROM postgres:16\n',
        'docker-compose.yml': 'services:\n  cache:\n    image: redis:7.2\n',
      },
      async (dir, ctx) => {
        await updateDockerImages(ctx, fetchTags);
        assert.ok((await readFile(join(dir, 'Dockerfile'), 'utf8')).includes('postgres:18'));
        assert.ok((await readFile(join(dir, 'docker-compose.yml'), 'utf8')).includes('redis:8.0'));
      }
    );
  });

  test('leaves a multi-stage stage-name ref (`FROM base`) untouched', async () => {
    const body = 'FROM postgres:16 AS base\nRUN echo hi\nFROM base\nCOPY --from=base /x /x\n';
    await withDockerfile(body, async (dir, ctx) => {
      await updateDockerImages(ctx, fetchTags);
      const out = await readFile(join(dir, 'Dockerfile'), 'utf8');
      assert.ok(out.includes('FROM postgres:18 AS base'), 'the real base image bumped');
      assert.ok(out.includes('\nFROM base\n'), 'stage-name reference left as-is (no tag to bump)');
    });
  });

  test('bumps past a `--platform=` prefix on the FROM line', async () => {
    await withDockerfile('FROM --platform=linux/amd64 postgres:16\n', async (dir, ctx) => {
      await updateDockerImages(ctx, fetchTags);
      const out = await readFile(join(dir, 'Dockerfile'), 'utf8');
      assert.equal(out, 'FROM --platform=linux/amd64 postgres:18\n');
    });
  });

  test('rewriting a bare-major ref never bleeds into a longer-precision sibling', async () => {
    // Tags chosen so `postgres:16` bumps (bare major → 18) but `postgres:16.3` is already the
    // newest 2-segment tag and must stay. If the token boundary is wrong, bumping `postgres:16`
    // eats the `16` inside `postgres:16.3` and wrongly rewrites it to `18.3` — this asserts it does
    // not. (A sibling that also bumped to `…18.3` would hide the bug; here it must stay put.)
    const tags = async (ref: ImageRef): Promise<string[]> =>
      ref.repository.endsWith('/postgres') ? ['16', '17', '18', '16.3'] : [];
    const body = 'FROM postgres:16\nFROM postgres:16.3\n';
    await withDockerfile(body, async (dir, ctx) => {
      await updateDockerImages(ctx, tags);
      const out = await readFile(join(dir, 'Dockerfile'), 'utf8');
      assert.equal(out, 'FROM postgres:18\nFROM postgres:16.3\n');
    });
  });

  test('best-effort: a fetcher that throws for one image leaves it, still bumps the rest', async () => {
    const flaky = async (ref: ImageRef): Promise<string[]> => {
      if (ref.repository.endsWith('/redis')) {
        throw new Error('registry unreachable');
      }
      return fetchTags(ref);
    };
    await withDockerfile('FROM postgres:16\nFROM redis:7.2\n', async (dir, ctx) => {
      await updateDockerImages(ctx, flaky);
      const out = await readFile(join(dir, 'Dockerfile'), 'utf8');
      assert.ok(out.includes('FROM postgres:18'), 'healthy image still bumped');
      assert.ok(out.includes('FROM redis:7.2'), 'failed image left untouched, run not aborted');
    });
  });
});
