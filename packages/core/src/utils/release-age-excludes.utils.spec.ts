import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  formatExcludeRule,
  parseExcludeRule,
  upsertPnpmExcludeRules,
} from './release-age-excludes.utils.js';

describe('release-age excludes: rules', () => {
  test('parses bare names, patterns and version unions', () => {
    assert.deepEqual(parseExcludeRule('@enke.dev/*'), { name: '@enke.dev/*', versions: [] });
    assert.deepEqual(parseExcludeRule('tsx@4.23.12'), { name: 'tsx', versions: ['4.23.12'] });
    assert.deepEqual(parseExcludeRule('@enke.dev/lint@0.13.2 || 0.13.3'), {
      name: '@enke.dev/lint',
      versions: ['0.13.2', '0.13.3'],
    });
  });

  test('quotes scoped rules, leaves plain ones bare', () => {
    assert.equal(formatExcludeRule({ name: 'tsx', versions: ['1.0.0'] }), 'tsx@1.0.0');
    assert.equal(
      formatExcludeRule({ name: '@enke.dev/lint', versions: ['1.0.0', '1.0.1'] }),
      "'@enke.dev/lint@1.0.0 || 1.0.1'"
    );
  });
});

const YAML = `packages:
  - packages/*

minimumReleaseAgeExclude:
  - '@optiscaners/ui.assets@0.37.1 || 0.37.2'
  - '@enke.dev/lit-utils@0.4.4'
  - vite@8.2.0
onlyBuiltDependencies:
  - esbuild
`;

describe('release-age excludes: upsertPnpmExcludeRules', () => {
  test('replaces the rule of a named package and leaves the rest intact', () => {
    const out = upsertPnpmExcludeRules(
      YAML,
      new Map([['@enke.dev/lit-utils', ['0.4.4', '0.6.2']]])
    );
    assert.equal(
      out,
      `packages:
  - packages/*

minimumReleaseAgeExclude:
  - '@optiscaners/ui.assets@0.37.1 || 0.37.2'
  - vite@8.2.0
  - '@enke.dev/lit-utils@0.4.4 || 0.6.2'
onlyBuiltDependencies:
  - esbuild
`
    );
  });

  test('removes a rule when its versions are empty, drops the key when nothing is left', () => {
    const out = upsertPnpmExcludeRules(
      YAML,
      new Map([
        ['@optiscaners/ui.assets', []],
        ['@enke.dev/lit-utils', []],
        ['vite', []],
      ])
    );
    assert.equal(out, 'packages:\n  - packages/*\n\nonlyBuiltDependencies:\n  - esbuild\n');
  });

  test('appends the key when absent', () => {
    const out = upsertPnpmExcludeRules(
      'packages:\n  - packages/*\n',
      new Map([['tsx', ['1.0.0']]])
    );
    assert.equal(out, 'packages:\n  - packages/*\n\nminimumReleaseAgeExclude:\n  - tsx@1.0.0\n');
  });

  test('starts from an empty file', () => {
    const out = upsertPnpmExcludeRules('', new Map([['tsx', ['1.0.0']]]));
    assert.equal(out, 'minimumReleaseAgeExclude:\n  - tsx@1.0.0\n');
  });

  test('converts an inline list to block form', () => {
    const out = upsertPnpmExcludeRules(
      "minimumReleaseAgeExclude: ['a@1.0.0', b]\nfoo: bar\n",
      new Map([['c', ['2.0.0']]])
    );
    assert.equal(out, 'minimumReleaseAgeExclude:\n  - a@1.0.0\n  - b\n  - c@2.0.0\nfoo: bar\n');
  });
});
