// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
// The config parsers are pure, and `detectReleaseAge` takes an injectable executor, so the
// pnpm-version probe is driven offline.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PackageManager } from '../context/context.types.js';
import type { ExecResult } from './exec.utils.js';
import type { ReleaseAgePolicy } from './release-age.utils.js';
import {
  detectReleaseAge,
  isExemptFromReleaseAge,
  NO_RELEASE_AGE,
  parseBunfig,
  parseNpmrcMinutes,
  parsePnpmWorkspace,
  releaseAgeCutoff,
} from './release-age.utils.js';

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' });

describe('parseBunfig', () => {
  test('reads the cooldown from the [install] table', () => {
    const parsed = parseBunfig('[install]\nexact = true\nminimumReleaseAge = 86400\n');
    assert.equal(parsed.seconds, 86400);
  });

  test('ignores a same-named key in another table', () => {
    const parsed = parseBunfig('[test]\nminimumReleaseAge = 999\n\n[install]\nexact = true\n');
    assert.equal(parsed.seconds, undefined);
  });

  test('reads an inline excludes array', () => {
    const parsed = parseBunfig(
      '[install]\nminimumReleaseAge = 60\nminimumReleaseAgeExcludes = ["typescript", "@types/bun"]\n'
    );
    assert.deepEqual(parsed.excludes, ['typescript', '@types/bun']);
  });

  test('reads a multi-line excludes array', () => {
    const parsed = parseBunfig(
      '[install]\nminimumReleaseAgeExcludes = [\n  "typescript",\n  "@enke.dev/lint",\n]\n'
    );
    assert.deepEqual(parsed.excludes, ['typescript', '@enke.dev/lint']);
  });

  test('ignores a commented-out cooldown', () => {
    const parsed = parseBunfig('[install]\nexact = true # minimumReleaseAge = 5\n');
    assert.equal(parsed.seconds, undefined);
  });
});

describe('parsePnpmWorkspace', () => {
  test('reads the cooldown in minutes', () => {
    const parsed = parsePnpmWorkspace('packages:\n  - packages/*\nminimumReleaseAge: 1440\n');
    assert.equal(parsed.minutes, 1440);
  });

  test('reads a block-list of excludes', () => {
    const parsed = parsePnpmWorkspace(
      'minimumReleaseAge: 60\nminimumReleaseAgeExclude:\n  - webpack\n  - "@myorg/*"\npackages:\n  - .\n'
    );
    assert.deepEqual(parsed.excludes, ['webpack', '@myorg/*']);
  });

  test('reads the strict + missing-time toggles', () => {
    const parsed = parsePnpmWorkspace(
      'minimumReleaseAge: 60\nminimumReleaseAgeStrict: false\nminimumReleaseAgeIgnoreMissingTime: false\n'
    );
    assert.equal(parsed.strict, false);
    assert.equal(parsed.ignoreMissingTime, false);
  });

  test('leaves undeclared toggles undefined, so detection can default them', () => {
    const parsed = parsePnpmWorkspace('minimumReleaseAge: 60\n');
    assert.equal(parsed.strict, undefined);
    assert.equal(parsed.ignoreMissingTime, undefined);
  });
});

describe('parseNpmrcMinutes', () => {
  test('reads the kebab-case key', () => {
    assert.equal(parseNpmrcMinutes('save-exact=true\nminimum-release-age=30\n'), 30);
  });

  test('returns undefined when unset', () => {
    assert.equal(parseNpmrcMinutes('save-exact=true\n'), undefined);
  });
});

describe('detectReleaseAge', () => {
  test('npm repos are never gated — npm has no such setting', async () => {
    const policy = await detectReleaseAge('/repo', PackageManager.Npm);
    assert.equal(policy.seconds, 0);
  });

  test('an explicit override wins over detection', async () => {
    const policy = await detectReleaseAge('/repo', PackageManager.Bun, 120);
    assert.equal(policy.seconds, 120);
    assert.equal(policy.source, '--min-release-age');
  });

  test('an override of 0 disables the clamp', async () => {
    const policy = await detectReleaseAge('/repo', PackageManager.Bun, 0);
    assert.equal(policy.seconds, 0);
  });

  test('pnpm ≥11 gates by default, with nothing configured', async () => {
    const policy = await detectReleaseAge('/repo', PackageManager.Pnpm, undefined, async () =>
      ok('11.2.0\n')
    );
    assert.equal(policy.seconds, 86400);
  });

  test("pnpm's own default cooldown is non-strict, like pnpm itself", async () => {
    const policy = await detectReleaseAge('/repo', PackageManager.Pnpm, undefined, async () =>
      ok('11.2.0\n')
    );
    assert.equal(policy.strict, false);
    assert.equal(policy.ignoreMissingTime, true);
  });

  test('bun gates strictly — it errors on a blocked version, with no fallback', async () => {
    const policy = await detectReleaseAge('/repo', PackageManager.Bun, 120);
    assert.equal(policy.strict, true);
  });

  test('pnpm 10 does not gate by default', async () => {
    const policy = await detectReleaseAge('/repo', PackageManager.Pnpm, undefined, async () =>
      ok('10.18.0\n')
    );
    assert.equal(policy.seconds, 0);
  });
});

describe('isExemptFromReleaseAge', () => {
  const policy = (...excludes: string[]): ReleaseAgePolicy => ({
    ...NO_RELEASE_AGE,
    seconds: 60,
    excludes,
    source: 'test',
  });

  test('matches a bare package name', () => {
    assert.equal(isExemptFromReleaseAge(policy('typescript'), 'typescript', '6.0.3'), true);
    assert.equal(isExemptFromReleaseAge(policy('typescript'), 'lit', '3.2.0'), false);
  });

  test('matches a scope glob', () => {
    assert.equal(isExemptFromReleaseAge(policy('@enke.dev/*'), '@enke.dev/lint', '0.1.0'), true);
    assert.equal(isExemptFromReleaseAge(policy('@enke.dev/*'), '@other/lint', '0.1.0'), false);
  });

  test('a version-scoped entry only exempts matching versions', () => {
    const scoped = policy('nx@21.6.5');
    assert.equal(isExemptFromReleaseAge(scoped, 'nx', '21.6.5'), true);
    assert.equal(isExemptFromReleaseAge(scoped, 'nx', '21.6.6'), false);
  });
});

describe('releaseAgeCutoff', () => {
  test('is null without a gate, so no extra registry call is made', () => {
    assert.equal(releaseAgeCutoff(NO_RELEASE_AGE), null);
  });

  test('is `now` minus the cooldown', () => {
    const cutoff = releaseAgeCutoff({ ...NO_RELEASE_AGE, seconds: 60 }, 1_000_000);
    assert.equal(cutoff, 1_000_000 - 60_000);
  });
});
