// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
// Exercises the types-bun feature end-to-end against a copied fixture, with the Bun release pinned
// on the context (see src/testing/module-context.factory) and the registry lookup stubbed so no
// network call is made.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BUN_LATEST, contextFor } from '../../../testing/module-context.factory.js';
import { withFixture } from '../../../testing/with-fixture.harness.js';
import { readPackageJson } from '../../../utils/fs.utils.js';
import { updateTypesBun } from './types-bun.feature.js';

describe('types-bun feature', () => {
  test('pins @types/bun to the release matching the pinned Bun', async () => {
    await withFixture('bun', async dir => {
      const ranges: string[] = [];
      const resolveInRange = async (_pkg: string, range: string) => {
        ranges.push(range);
        return BUN_LATEST.version;
      };
      await updateTypesBun(contextFor(dir), resolveInRange);
      // the lookup is capped at the pinned Bun, so typings never run ahead of the runtime
      assert.deepEqual(ranges, [`<=${BUN_LATEST.version}`]);
      const pkg = await readPackageJson(dir);
      // fixture spec is an exact `1.1.30` → stays exact
      assert.equal(pkg?.devDependencies?.['@types/bun'], BUN_LATEST.version);
    });
  });

  test('takes the newest typings not exceeding the Bun release when they lag', async () => {
    await withFixture('bun', async dir => {
      await updateTypesBun(contextFor(dir), async () => '1.3.9');
      const pkg = await readPackageJson(dir);
      assert.equal(pkg?.devDependencies?.['@types/bun'], '1.3.9');
    });
  });

  test('a failed lookup and a dry-run both leave the spec untouched', async () => {
    await withFixture('bun', async dir => {
      await updateTypesBun(contextFor(dir), async () => null);
      assert.equal((await readPackageJson(dir))?.devDependencies?.['@types/bun'], '1.1.30');
      await updateTypesBun(contextFor(dir, true), async () => BUN_LATEST.version);
      assert.equal((await readPackageJson(dir))?.devDependencies?.['@types/bun'], '1.1.30');
    });
  });
});
