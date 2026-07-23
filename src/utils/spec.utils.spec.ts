// Runtime-agnostic test (node:test + node:assert): runs under both `bun test` and
// `node --test`. The whole `.spec.ts` suite avoids `bun:` imports so both runtimes run it.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isPinnable, isVersionRange, operatorOf, realignVersionSpec } from './spec.utils.js';

describe('isPinnable', () => {
  test('accepts concrete versions, with or without ^/~', () => {
    for (const spec of ['1.2.3', '^1.2.3', '~1.2.3', '0.0.0', '10.20.30']) {
      assert.equal(isPinnable(spec), true, spec);
    }
  });

  test('accepts prerelease and build metadata', () => {
    for (const spec of ['1.2.3-beta.1', '^1.0.0-rc.1', '~2.0.0+build.5', '1.0.0-alpha+meta']) {
      assert.equal(isPinnable(spec), true, spec);
    }
  });

  test('rejects wildcards and partial versions (left untouched, not pinned)', () => {
    for (const spec of ['1.x', '1.2.x', '1', '1.2', '1.X', '*', 'x']) {
      assert.equal(isPinnable(spec), false, spec);
    }
  });

  test('rejects ranges', () => {
    for (const spec of ['>=4.8.4 <6.1.0', '4 || 5', '>1.0.0', '<=2.0.0']) {
      assert.equal(isPinnable(spec), false, spec);
    }
  });

  test('rejects protocol/tag/alias specs', () => {
    for (const spec of ['workspace:*', 'catalog:', 'link:../foo', 'npm:pkg@1.2.3', 'latest', '']) {
      assert.equal(isPinnable(spec), false, spec);
    }
  });
});

describe('operatorOf', () => {
  test('extracts leading range operator', () => {
    assert.equal(operatorOf('^1.2.3'), '^');
    assert.equal(operatorOf('~1.2.3'), '~');
    assert.equal(operatorOf('1.2.3'), '');
  });
});

describe('realignVersionSpec', () => {
  const version = '22.15.1';
  const major = 22;

  test('preserves the operator', () => {
    assert.equal(realignVersionSpec('>=20', version, major), '>=22');
    assert.equal(realignVersionSpec('>20', version, major), '>22');
    assert.equal(realignVersionSpec('^20', version, major), '^22');
    assert.equal(realignVersionSpec('~20', version, major), '~22');
    assert.equal(realignVersionSpec('=20', version, major), '=22');
    assert.equal(realignVersionSpec('20', version, major), '22');
    assert.equal(realignVersionSpec(' ^20 ', version, major), '^22');
  });

  test('major-only stays major, fuller specs take the full version', () => {
    assert.equal(realignVersionSpec('>=20', version, major), '>=22');
    assert.equal(realignVersionSpec('^20.0.0', version, major), '^22.15.1');
    assert.equal(realignVersionSpec('20.11.0', version, major), '22.15.1');
    assert.equal(realignVersionSpec('~20.1', version, major), '~22.15');
    assert.equal(realignVersionSpec('>=20.0.0', version, major), '>=22.15.1');
  });

  test('leaves compound ranges, unions, wildcards and tags untouched (null)', () => {
    for (const spec of [
      '>=18 <21',
      '18 || 20',
      '20 || 22',
      '*',
      'lts/*',
      'latest',
      '',
      '20.x',
      '20.X',
      '^20.x',
      '1.2.x',
    ]) {
      assert.equal(realignVersionSpec(spec, version, major), null, spec);
    }
  });
});

describe('isVersionRange', () => {
  test('detects multi-version ranges', () => {
    for (const spec of ['>=4.8.4 <6.1.0', '4 || 5', '>1.0.0 <2.0.0']) {
      assert.equal(isVersionRange(spec), true, spec);
    }
  });

  test('pinnable versions are not ranges', () => {
    for (const spec of ['1.2.3', '^1.2.3', '~1.2.3']) {
      assert.equal(isVersionRange(spec), false, spec);
    }
  });

  test('wildcards/partials are neither pinnable nor a cap range (left fully untouched)', () => {
    for (const spec of ['1.x', '1.2', '1']) {
      assert.equal(isPinnable(spec), false, spec);
      assert.equal(isVersionRange(spec), false, spec);
    }
  });
});
