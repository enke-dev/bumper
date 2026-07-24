// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
// Exercises the types-node feature end-to-end against a copied fixture, with the Node LTS pinned on
// the context (see src/testing/context) and the registry lookup stubbed so no network call is made.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { contextFor, LTS } from '../../../testing/module-context.factory.js';
import { withFixture } from '../../../testing/with-fixture.harness.js';
import { readPackageJson } from '../../../utils/fs.utils.js';
import { updateTypesNode } from './types-node.feature.js';

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
