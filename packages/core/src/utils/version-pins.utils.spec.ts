// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { withTempDir } from '../testing/with-temp-dir.harness.js';
import { pathExists } from './fs.utils.js';
import type { PackageJson } from './package.types.js';
import {
  realignDevEngines,
  realignEngines,
  realignMiseTools,
  realignToolConfigs,
  realignToolVersions,
} from './version-pins.utils.js';

const PIN = { version: '24.11.0', major: 24 };

describe('realignToolVersions', () => {
  test('realigns the listed tools, keeping precision, fallbacks and other tools', () => {
    const text = ['nodejs 22.1.0 20.0.0', 'node 22', 'python 3.12.1', ''].join('\n');
    assert.equal(
      realignToolVersions(text, ['nodejs', 'node'], PIN),
      ['nodejs 24.11.0 20.0.0', 'node 24', 'python 3.12.1', ''].join('\n')
    );
  });

  test('leaves aliases, refs, comments and held lines as written', () => {
    const text = [
      'nodejs lts',
      'nodejs ref:v22.1.0',
      '# nodejs 20',
      '# bumper: skip',
      'nodejs 20.0.0',
    ].join('\n');
    assert.equal(realignToolVersions(text, ['nodejs'], PIN), text);
  });
});

describe('realignMiseTools', () => {
  test('realigns tool lines in the [tools] table only', () => {
    const text = [
      '[env]',
      'node = "20"',
      '',
      '[tools]',
      'node = "22.1"',
      "bun = '1.2.0'",
      'python = "3.12"',
      '',
    ].join('\n');
    const out = realignMiseTools(text, ['node'], PIN);
    assert.ok(out.includes('[env]\nnode = "20"'), 'other tables stay');
    assert.ok(out.includes('[tools]\nnode = "24.11"'), 'precision kept');
    assert.ok(out.includes("bun = '1.2.0'"), 'other tools stay');
  });

  test('leaves aliases, inline tables and held lines as written', () => {
    const text = [
      '[tools]',
      'node = "lts"',
      'nodejs = { version = "22" }',
      '# bumper: skip',
      'node = "20"',
    ].join('\n');
    assert.equal(realignMiseTools(text, ['node', 'nodejs'], PIN), text);
  });
});

describe('realignToolConfigs', () => {
  test('rewrites the configs a workspace keeps, creating none', async () => {
    await withTempDir('version-pins', async dir => {
      await writeFile(join(dir, '.tool-versions'), 'nodejs 22.1.0\n');
      await realignToolConfigs(dir, ['nodejs'], PIN);
      assert.equal(await readFile(join(dir, '.tool-versions'), 'utf8'), 'nodejs 24.11.0\n');
      assert.equal(await pathExists(join(dir, 'mise.toml')), false);
    });
  });
});

describe('realignEngines', () => {
  test('realigns an existing floor, injecting none', () => {
    const pkg: PackageJson = { engines: { node: '>=22' } };
    assert.equal(realignEngines(pkg, 'node', PIN), true);
    assert.equal(pkg.engines?.['node'], '>=24');
    const bare: PackageJson = {};
    assert.equal(realignEngines(bare, 'node', PIN), false);
    assert.equal(bare.engines, undefined);
  });
});

describe('realignDevEngines', () => {
  test('realigns a single entry or a list, by name', () => {
    const pkg: PackageJson = {
      devEngines: {
        runtime: [
          { name: 'node', version: '^22.1.0' },
          { name: 'bun', version: '>=1.1' },
        ],
        packageManager: { name: 'bun', version: '1.1.0' },
      },
    };
    assert.equal(realignDevEngines(pkg, 'node', PIN), true);
    assert.equal(
      realignDevEngines(pkg, 'bun', { version: '1.3.2', major: 1 }, ['runtime', 'packageManager']),
      true
    );
    assert.deepEqual(pkg['devEngines'], {
      runtime: [
        { name: 'node', version: '^24.11.0' },
        { name: 'bun', version: '>=1.3' },
      ],
      packageManager: { name: 'bun', version: '1.3.2' },
    });
  });

  test('leaves entries without a version, ranges and other fields alone', () => {
    const devEngines = {
      runtime: [{ name: 'node' }, { name: 'node', version: '>=20 <23' }],
      packageManager: { name: 'node', version: '22' },
    };
    const pkg: PackageJson = { devEngines: structuredClone(devEngines) };
    assert.equal(realignDevEngines(pkg, 'node', PIN), false);
    assert.deepEqual(pkg['devEngines'], devEngines);
  });
});
