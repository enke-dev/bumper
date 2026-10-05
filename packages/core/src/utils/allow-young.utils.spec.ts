// Runtime-agnostic (bun test + node --test): registry lookups are injected, the fs is a tmpdir.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { PackageManager } from '../context/context.types.js';
import { contextFor } from '../testing/module-context.factory.js';
import { makeTempDir } from '../testing/with-temp-dir.harness.js';
import {
  recordYoungConsumptions,
  youngConsumptions,
  youngInstallArgs,
} from './allow-young.utils.js';
import { writePackageJson } from './fs.utils.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-05T12:00:00Z');

/** Fake `publishTimes`: lit-utils 0.6.2 is an hour old, 0.6.1 a week old, 0.4.4 a year old. */
const times = async (pkg: string): Promise<Record<string, number>> =>
  pkg === '@enke.dev/lit-utils'
    ? { '0.4.4': NOW - 365 * DAY, '0.6.1': NOW - 7 * DAY, '0.6.2': NOW - 60 * 60 * 1000 }
    : {};

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('allow-young');
  await writePackageJson(dir, {
    name: 'consumer',
    dependencies: { '@enke.dev/lit-utils': '0.6.2', lit: '3.3.3' },
  });
});

afterEach(() => rm(dir, { recursive: true, force: true }));

function ctx(overrides: Partial<ReturnType<typeof contextFor>> = {}) {
  return {
    ...contextFor(dir),
    packageManager: PackageManager.Pnpm,
    releaseAge: {
      seconds: DAY / 1000,
      excludes: ['@enke.dev/lit-utils@0.4.4 || 0.6.1'],
      strict: true,
      ignoreMissingTime: true,
      source: 'test',
    },
    allowYoung: ['@enke.dev/lit-utils'],
    ...overrides,
  };
}

describe('allow-young: youngConsumptions', () => {
  test('reports the pinned versions still inside the cooldown', async () => {
    const result = await youngConsumptions(ctx(), times, NOW);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, '@enke.dev/lit-utils');
    assert.deepEqual(result[0]?.young, ['0.6.2']);
  });

  test('nothing without a gate, without allow-young, or when the version is old enough', async () => {
    assert.deepEqual(await youngConsumptions(ctx({ allowYoung: [] }), times, NOW), []);
    assert.deepEqual(
      await youngConsumptions(ctx(), times, NOW + 2 * DAY),
      [],
      'two days later the version has cleared the cooldown'
    );
    const open = ctx();
    open.releaseAge = { ...open.releaseAge, seconds: 0 };
    assert.deepEqual(await youngConsumptions(open, times, NOW), []);
  });

  test('a version the repo already exempts needs no help', async () => {
    const exempt = ctx();
    exempt.releaseAge = { ...exempt.releaseAge, excludes: ['@enke.dev/lit-utils@0.6.2'] };
    assert.deepEqual(await youngConsumptions(exempt, times, NOW), []);
  });
});

describe('allow-young: recordYoungConsumptions (pnpm)', () => {
  test('pins the young version and prunes versions that cleared the cooldown', async () => {
    await writeFile(
      join(dir, 'pnpm-workspace.yaml'),
      "packages:\n  - packages/*\nminimumReleaseAgeExclude:\n  - '@enke.dev/lit-utils@0.4.4 || 0.6.1'\n  - vite@8.2.0\n"
    );
    await recordYoungConsumptions(ctx(), times, NOW);
    assert.equal(
      await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'),
      "packages:\n  - packages/*\nminimumReleaseAgeExclude:\n  - vite@8.2.0\n  - '@enke.dev/lit-utils@0.6.2'\n"
    );
  });

  test('keeps a pinned version that is still young', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    const recent = ctx();
    recent.releaseAge = { ...recent.releaseAge, seconds: (30 * DAY) / 1000 };
    await recordYoungConsumptions(recent, times, NOW);
    assert.equal(
      await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'),
      "packages:\n  - packages/*\n\nminimumReleaseAgeExclude:\n  - '@enke.dev/lit-utils@0.6.1 || 0.6.2'\n"
    );
  });

  test('dry-run writes nothing', async () => {
    await recordYoungConsumptions(ctx({ dryRun: true }), times, NOW);
    assert.equal(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8').catch(() => null), null);
  });
});

describe('allow-young: youngInstallArgs (bun)', () => {
  test('lifts the gate for the install only when something young was consumed', async () => {
    const bun = ctx({ packageManager: PackageManager.Bun });
    assert.deepEqual(await youngInstallArgs(bun, times, NOW), ['--minimum-release-age', '0']);
    assert.deepEqual(await youngInstallArgs(bun, times, NOW + 2 * DAY), []);
  });
});
