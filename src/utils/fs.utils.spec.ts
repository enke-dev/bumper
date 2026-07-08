// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  allDependencies,
  anyExists,
  globFiles,
  pathExists,
  readPackageJson,
  writePackageJson,
} from './fs.utils.js';
import type { PackageJson } from './package.types.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bumper-fs-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('pathExists', () => {
  test('returns true for an existing file', async () => {
    const file = join(dir, 'a.txt');
    await writeFile(file, 'x');
    assert.equal(await pathExists(file), true);
  });

  test('returns true for an existing directory', async () => {
    assert.equal(await pathExists(dir), true);
  });

  test('returns false for a missing path', async () => {
    assert.equal(await pathExists(join(dir, 'nope')), false);
  });
});

describe('anyExists', () => {
  test('returns true when at least one name exists', async () => {
    await writeFile(join(dir, 'bun.lock'), '');
    assert.equal(await anyExists(dir, ['pnpm-lock.yaml', 'bun.lock']), true);
  });

  test('returns false when none exist', async () => {
    assert.equal(await anyExists(dir, ['pnpm-lock.yaml', 'package-lock.json']), false);
  });
});

describe('globFiles', () => {
  test('returns absolute paths to matching files only', async () => {
    await writeFile(join(dir, 'a.json'), '{}');
    await writeFile(join(dir, 'b.json'), '{}');
    await writeFile(join(dir, 'c.txt'), 'x');

    const files = await globFiles(dir, '*.json');
    assert.deepEqual(files.sort(), [join(dir, 'a.json'), join(dir, 'b.json')]);
  });

  test('excludes directories that match the pattern', async () => {
    await mkdir(join(dir, 'nested.json'));
    await writeFile(join(dir, 'real.json'), '{}');

    const files = await globFiles(dir, '*.json');
    assert.deepEqual(files, [join(dir, 'real.json')]);
  });

  test('returns an empty array when nothing matches', async () => {
    assert.deepEqual(await globFiles(dir, '*.nope'), []);
  });
});

describe('readPackageJson', () => {
  test('reads and parses a package.json', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'foo', version: '1.0.0' }));
    assert.deepEqual(await readPackageJson(dir), { name: 'foo', version: '1.0.0' });
  });

  test('returns null when the file is absent', async () => {
    assert.equal(await readPackageJson(dir), null);
  });

  test('returns null when the file is invalid JSON', async () => {
    await writeFile(join(dir, 'package.json'), '{ not json');
    assert.equal(await readPackageJson(dir), null);
  });
});

describe('writePackageJson', () => {
  test('writes two-space indented JSON with a trailing newline', async () => {
    const pkg: PackageJson = { name: 'foo', version: '1.0.0' };
    await writePackageJson(dir, pkg);

    const raw = await readFile(join(dir, 'package.json'), 'utf8');
    assert.equal(raw, `${JSON.stringify(pkg, null, 2)}\n`);
    assert.ok(raw.endsWith('\n'));
  });

  test('round-trips through readPackageJson', async () => {
    const pkg: PackageJson = { name: 'bar', dependencies: { lit: '^3.0.0' } };
    await writePackageJson(dir, pkg);
    assert.deepEqual(await readPackageJson(dir), pkg);
  });
});

describe('allDependencies', () => {
  test('merges every dependency bucket', () => {
    const pkg: PackageJson = {
      dependencies: { a: '1.0.0' },
      devDependencies: { b: '2.0.0' },
      optionalDependencies: { c: '3.0.0' },
      peerDependencies: { d: '4.0.0' },
    };
    assert.deepEqual(allDependencies(pkg), { a: '1.0.0', b: '2.0.0', c: '3.0.0', d: '4.0.0' });
  });

  test('later buckets override earlier ones for the same name', () => {
    const pkg: PackageJson = {
      dependencies: { a: '1.0.0' },
      peerDependencies: { a: '4.0.0' },
    };
    assert.deepEqual(allDependencies(pkg), { a: '4.0.0' });
  });

  test('returns an empty object for a package with no deps', () => {
    assert.deepEqual(allDependencies({ name: 'empty' }), {});
  });
});
