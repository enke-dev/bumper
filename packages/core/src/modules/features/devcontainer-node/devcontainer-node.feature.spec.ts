// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
// The Node LTS is pinned on the context (see src/testing/module-context.factory), so no network.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { contextFor, NODE_LTS } from '../../../testing/module-context.factory.js';
import { withTempDir } from '../../../testing/with-temp-dir.harness.js';
import {
  alignDevcontainer,
  devcontainerNodeFeature,
  updateDevcontainerNode,
} from './devcontainer-node.feature.js';

const PIN = { version: '24.11.0', major: 24 };
const anyTag = () => true;

describe('alignDevcontainer', () => {
  test('aligns the node major of the typescript/javascript-node images', () => {
    const text = [
      '"image": "mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm"',
      '"image": "mcr.microsoft.com/devcontainers/javascript-node:20"',
      '"image": "mcr.microsoft.com/devcontainers/typescript-node:1"',
    ].join('\n');
    assert.equal(
      alignDevcontainer(text, PIN, anyTag),
      [
        '"image": "mcr.microsoft.com/devcontainers/typescript-node:1-24-bookworm"',
        '"image": "mcr.microsoft.com/devcontainers/javascript-node:24"',
        // the image version alone names no node major
        '"image": "mcr.microsoft.com/devcontainers/typescript-node:1"',
      ].join('\n')
    );
  });

  test("realigns the node feature's version, keeping precision, aliases and other features", () => {
    const text = [
      '{',
      '  "features": {',
      '    "ghcr.io/devcontainers/features/python:1": { "version": "3.12" },',
      '    "ghcr.io/devcontainers/features/node:1": {',
      '      "nodeGypDependencies": true,',
      '      "version": "22.1"',
      '    },',
      '    "ghcr.io/devcontainers/features/go:1": {',
      '      "version": "1.22"',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const out = alignDevcontainer(text, PIN, anyTag);
    assert.ok(out.includes('"version": "24.11"'), 'node feature aligned');
    assert.ok(out.includes('{ "version": "3.12" }') && out.includes('"version": "1.22"'));
    const inline = '"ghcr.io/devcontainers/features/node:1": { "version": "lts" }';
    assert.equal(alignDevcontainer(inline, PIN, anyTag), inline, 'alias stays');
  });

  test('moves an image only to a published tag', () => {
    const text = [
      '"image": "mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm"',
      '"image": "mcr.microsoft.com/vscode/devcontainers/typescript-node:0-18-bullseye"',
    ].join('\n');
    const published = (repo: string, tag: string) =>
      repo === 'mcr.microsoft.com/devcontainers/typescript-node' && tag === '1-24-bookworm';
    assert.equal(
      alignDevcontainer(text, PIN, published),
      text.replace('1-22-bookworm', '1-24-bookworm')
    );
  });

  test('holds a line below a `// bumper: skip` comment', () => {
    const text = [
      '  // bumper: skip - matches prod',
      '  "image": "mcr.microsoft.com/devcontainers/typescript-node:1-20"',
    ].join('\n');
    assert.equal(alignDevcontainer(text, PIN, anyTag), text);
  });
});

describe('devcontainer-node feature', () => {
  const fetchTags = async () => [`1-${NODE_LTS.major}`];

  test('rewrites .devcontainer configs, named ones included', async () => {
    await withTempDir('devcontainer-node', async dir => {
      const named = join(dir, '.devcontainer', 'web');
      await mkdir(named, { recursive: true });
      const body = '{ "image": "mcr.microsoft.com/devcontainers/typescript-node:1-20" }\n';
      await writeFile(join(dir, '.devcontainer', 'devcontainer.json'), body);
      await writeFile(join(named, 'devcontainer.json'), body);
      assert.equal(await devcontainerNodeFeature.isUsed(contextFor(dir)), true);

      await updateDevcontainerNode(contextFor(dir), fetchTags);
      const expected = body.replace('1-20', `1-${NODE_LTS.major}`);
      assert.equal(
        await readFile(join(dir, '.devcontainer', 'devcontainer.json'), 'utf8'),
        expected
      );
      assert.equal(await readFile(join(named, 'devcontainer.json'), 'utf8'), expected);
    });
  });

  test('aligns the node images in Docker files too, and owns them', async () => {
    await withTempDir('devcontainer-node', async dir => {
      await mkdir(join(dir, '.devcontainer'), { recursive: true });
      const file = join(dir, '.devcontainer', 'Dockerfile');
      await writeFile(file, 'FROM mcr.microsoft.com/devcontainers/typescript-node:1-20\n');
      await updateDevcontainerNode(contextFor(dir), fetchTags);
      assert.equal(
        await readFile(file, 'utf8'),
        `FROM mcr.microsoft.com/devcontainers/typescript-node:1-${NODE_LTS.major}\n`
      );
      const owned = await devcontainerNodeFeature.managedImages?.(contextFor(dir));
      assert.ok(owned?.includes('mcr.microsoft.com/devcontainers/typescript-node'));
    });
  });

  test('applies only to configs that use a node image or feature', async () => {
    await withTempDir('devcontainer-node', async dir => {
      assert.equal(await devcontainerNodeFeature.isUsed(contextFor(dir)), false, 'none');
      await writeFile(join(dir, '.devcontainer.json'), '{ "image": "python:3" }\n');
      assert.equal(await devcontainerNodeFeature.isUsed(contextFor(dir)), false, 'no node');
    });
  });
});
