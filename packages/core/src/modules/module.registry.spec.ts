// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
// Detection per module against real fixtures lives in detection.spec; this pins the parts of
// detectModules that config drives directly — the `forced` flag and a toggle steering `used` —
// so they stay deterministic and don't depend on what the tmp dir happens to contain.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { contextFor } from '../testing/module-context.factory.js';
import { withTempDir } from '../testing/with-temp-dir.harness.js';
import { detectModules } from './module.registry.js';

describe('detectModules', () => {
  test('reports `forced` for toggled modules, and a toggle steers `used`', async () => {
    await withTempDir('registry', async dir => {
      const base = contextFor(dir);
      const ctx = {
        ...base,
        config: { ...base.config, modules: { 'docker-images': false, 'docker-node': true } },
      };
      const byId = new Map((await detectModules(ctx)).map(status => [status.id, status]));

      // a toggle short-circuits isUsed, so `used` follows it regardless of the (empty) tmp dir
      assert.equal(byId.get('docker-images')?.forced, true);
      assert.equal(byId.get('docker-images')?.used, false);
      assert.equal(byId.get('docker-node')?.forced, true);
      assert.equal(byId.get('docker-node')?.used, true);

      // an un-toggled module is never `forced`; its `used` stays auto-detected (not asserted here)
      assert.equal(byId.get('node')?.forced, false);
    });
  });
});
