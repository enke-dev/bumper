// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
// Exercises the bun runtime end-to-end against a copied fixture, with the Bun release pinned on
// the context (see src/testing/module-context.factory) so no registry call is made.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { BUN_LATEST, contextFor } from '../../../testing/module-context.factory.js';
import { withFixture } from '../../../testing/with-fixture.harness.js';
import { pathExists, readPackageJson } from '../../../utils/fs.utils.js';
import { bunRuntime } from './bun.runtime.js';

describe('bun runtime', () => {
  test('writes the bare release (no v prefix) to the root .bun-version', async () => {
    await withFixture('bun', async dir => {
      // fixture ships no .bun-version → the root pin is created (bumper's canonical pin)
      await bunRuntime.update(contextFor(dir));
      assert.equal(await readFile(join(dir, '.bun-version'), 'utf8'), `${BUN_LATEST.version}\n`);
    });
  });

  test('aligns a member .bun-version only where one already exists', async () => {
    await withFixture('bun', async dir => {
      const pinned = join(dir, 'packages', 'pinned');
      const bare = join(dir, 'packages', 'bare');
      await Promise.all([mkdir(pinned, { recursive: true }), mkdir(bare, { recursive: true })]);
      await writeFile(join(pinned, '.bun-version'), '1.1.0\n');
      const ctx = { ...contextFor(dir), workspaces: [dir, pinned, bare] };
      await bunRuntime.update(ctx);
      assert.equal(await readFile(join(pinned, '.bun-version'), 'utf8'), `${BUN_LATEST.version}\n`);
      assert.equal(await pathExists(join(bare, '.bun-version')), false, 'no pin imposed');
    });
  });

  test('aligns an existing engines.bun floor, preserving operator + precision', async () => {
    await withFixture('bun', async dir => {
      // fixture declares `>=1.1` → minor-granular, operator preserved
      await bunRuntime.update(contextFor(dir));
      const pkg = await readPackageJson(dir);
      const [major, minor] = BUN_LATEST.version.split('.');
      assert.equal(pkg?.engines?.['bun'], `>=${major}.${minor}`);
    });
  });

  test('dry-run leaves .bun-version and engines.bun untouched', async () => {
    await withFixture('bun', async dir => {
      const before = await readPackageJson(dir);
      await bunRuntime.update(contextFor(dir, true));
      assert.equal(await pathExists(join(dir, '.bun-version')), false);
      const after = await readPackageJson(dir);
      assert.equal(after?.engines?.['bun'], before?.engines?.['bun']);
    });
  });
});
