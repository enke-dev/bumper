// Runtime-agnostic (bun test + node --test): the schema drives `config set` parsing.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { normalizeRepoConfig } from './config.js';
import { applyConfigValue, configKeysUsage, resolveConfigKey } from './config.schema.js';

const base = normalizeRepoConfig({});

describe('config schema: defaults', () => {
  test('normalize fills every field with its default and leaves optional ones absent', () => {
    assert.deepEqual(base, { exclude: [], modules: {}, checks: [], waitForRelease: true });
    assert.equal('branch' in base, false);
  });

  test('normalize keeps stored values', () => {
    const entry = normalizeRepoConfig({ exclude: ['x'], branch: 'main', waitForRelease: false });
    assert.deepEqual(entry, {
      exclude: ['x'],
      modules: {},
      branch: 'main',
      checks: [],
      waitForRelease: false,
    });
  });
});

describe('config schema: keys', () => {
  test('resolves plain keys and boolean-map ids, rejects unknown keys', () => {
    assert.equal(resolveConfigKey('exclude')?.field.key, 'exclude');
    assert.deepEqual(resolveConfigKey('modules.node')?.id, 'node');
    assert.equal(resolveConfigKey('modules')?.field.key, 'modules');
    assert.equal(resolveConfigKey('nope'), null);
    assert.equal(resolveConfigKey('modules.'), null);
  });

  test('every field appears in the usage lines', () => {
    const usage = configKeysUsage().join('\n');
    ['exclude', 'modules.<id>', 'branch', 'checks', 'waitForRelease'].forEach(key =>
      assert.ok(usage.includes(key), `usage lists ${key}`)
    );
  });
});

describe('config schema: applyConfigValue', () => {
  test('string-list takes every token, empty clears', () => {
    const set = applyConfigValue(base, 'checks', ['lint', ' test ', '']);
    assert.deepEqual(set.checks, ['lint', 'test']);
    assert.deepEqual(applyConfigValue(set, 'checks', []).checks, []);
  });

  test('string takes one token, "-" removes it', () => {
    const set = applyConfigValue(base, 'branch', ['chore/deps']);
    assert.equal(set.branch, 'chore/deps');
    assert.equal('branch' in applyConfigValue(set, 'branch', ['-']), false);
    assert.throws(() => applyConfigValue(base, 'branch', ['a', 'b']), /single value/);
  });

  test('boolean takes true|false only', () => {
    assert.equal(applyConfigValue(base, 'waitForRelease', ['false']).waitForRelease, false);
    assert.throws(() => applyConfigValue(base, 'waitForRelease', ['yes']), /true\|false/);
  });

  test('boolean-map sets one id without touching the others', () => {
    const one = applyConfigValue(base, 'modules.node', ['false']);
    const two = applyConfigValue(one, 'modules.pnpm', ['true']);
    assert.deepEqual(two.modules, { node: false, pnpm: true });
    assert.deepEqual(base.modules, {});
  });

  test('unknown key throws', () => {
    assert.throws(() => applyConfigValue(base, 'colour', ['red']), /unknown config key/);
  });
});
