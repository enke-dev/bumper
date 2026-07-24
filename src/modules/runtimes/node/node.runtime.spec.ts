// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
// Exercises the node runtime end-to-end against a copied fixture, with the Node LTS pinned on the
// context (see module-test-kit) so no network call is made.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { pathExists, readPackageJson } from '../../../utils/fs.utils.js';
import { contextFor, LTS, withFixture } from '../../module-test-kit.js';
import { nodeRuntime } from './node.runtime.js';

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
