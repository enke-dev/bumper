// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
// Registry lookups are injected (see `RegistryLookups`), so the orchestrator runs offline
// without module mocking. fs stays real, backed by a tmpdir.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { compareReversed, getPrerelease, satisfies } from 'verkit';

import type { ModuleContext } from '../context/context.types.js';
import { PackageManager } from '../context/context.types.js';
import { makeTempDir } from '../testing/with-temp-dir.harness.js';
import { readPackageJson, writePackageJson } from './fs.utils.js';
import type { PackageJson } from './package.types.js';
import type { RegistryLookups } from './upgrade.utils.js';
import { upgradeAllWorkspaces } from './upgrade.utils.js';

let dir: string;
let latest: Record<string, string | null>;
let versions: Record<string, string[]>;
let peers: Record<string, Record<string, string>>;

/**
 * Offline stand-in for the network-backed registry lookups. `latest` feeds the global-latest
 * lookup; `peers` (keyed by package name) stands for the peers of the version being bumped *to*;
 * `versions` is the candidate pool `maxSatisfyingRanges` filters. That lookup runs the *real*
 * verkit `satisfies` intersection here — order-independent, `||` honored — so the tests exercise
 * the actual cap algebra rather than a hard-coded answer.
 */
const lookups: RegistryLookups = {
  latestVersion: async pkg => latest[pkg] ?? null,
  maxSatisfyingRanges: async (pkg, ranges) =>
    (versions[pkg] ?? [])
      .filter(v => getPrerelease(v)?.length === 0) // mirror the real impl: stable versions only
      .filter(v => ranges.every(range => satisfies(v, range)))
      .sort(compareReversed)[0] ?? null,
  peerDependencies: async pkg => peers[pkg] ?? {},
};

function ctx(overrides: Partial<ModuleContext> = {}): ModuleContext {
  return {
    cwd: dir,
    workspaces: [dir],
    packageManager: PackageManager.Npm,
    dryRun: false,
    ...overrides,
  } as ModuleContext;
}

function writePkg(pkg: PackageJson): Promise<void> {
  return writePackageJson(dir, pkg);
}

/** Swap `process.stdout.write` for a buffer; runtime-agnostic (no bun/jest spy API). */
function captureStdout(): { output: () => string; restore: () => void } {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  process.stdout.write = ((chunk: unknown) => {
    buffer += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    output: () => buffer,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

beforeEach(async () => {
  dir = await makeTempDir('upgrade');
  latest = {};
  versions = {};
  peers = {};
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('upgradeAllWorkspaces', () => {
  test('rewrites pinnable specs to latest, preserving the ^/~ operator', async () => {
    latest = { lit: '3.2.0', typescript: '5.9.0' };
    await writePkg({
      name: 'root',
      dependencies: { lit: '^3.0.0' },
      devDependencies: { typescript: '~5.0.0' },
    });

    await upgradeAllWorkspaces(ctx(), lookups);

    const pkg = await readPackageJson(dir);
    assert.equal(pkg?.dependencies?.['lit'], '^3.2.0');
    assert.equal(pkg?.devDependencies?.['typescript'], '~5.9.0');
  });

  test('never downgrades a pinned prerelease to a lower `latest` dist-tag', async () => {
    // Regression (estino/ui): `vitepress` pinned to a `next` prerelease while the `latest`
    // dist-tag is an older stable — `latestVersion` returns the stable, which must NOT overwrite
    // the newer prerelease pin.
    latest = { vitepress: '1.6.4', lit: '3.2.0' };
    await writePkg({
      name: 'root',
      devDependencies: { vitepress: '2.0.0-alpha.13', lit: '^3.0.0' },
    });

    await upgradeAllWorkspaces(ctx(), lookups);

    const pkg = await readPackageJson(dir);
    assert.equal(pkg?.devDependencies?.['vitepress'], '2.0.0-alpha.13', 'prerelease left intact');
    assert.equal(pkg?.devDependencies?.['lit'], '^3.2.0', 'normal dep still bumps');
  });

  test('a peer cap never downgrades a pinned prerelease that still satisfies the peer range', async () => {
    // Regression (lit-utils): vitepress is pinned to a `next` prerelease and peer-capped by
    // vitepress-plugin-pagefind (`^1.0.0-0 || ^2.0.0-0`, which the alpha satisfies). The cap
    // resolves to the newest *stable* (1.6.4) — but must NOT downgrade the still-valid alpha pin.
    latest = { vitepress: '1.6.4', 'vitepress-plugin-pagefind': '0.4.22' };
    versions = { vitepress: ['1.6.4', '2.0.0-alpha.18'] }; // stable-only filter leaves 1.6.4
    peers = { 'vitepress-plugin-pagefind': { vitepress: '^1.0.0-0 || ^2.0.0-0' } };
    await writePkg({
      name: 'root',
      devDependencies: { vitepress: '2.0.0-alpha.13', 'vitepress-plugin-pagefind': '0.4.22' },
    });

    await upgradeAllWorkspaces(ctx(), lookups);

    const pkg = await readPackageJson(dir);
    assert.equal(pkg?.devDependencies?.['vitepress'], '2.0.0-alpha.13', 'prerelease pin kept');
  });

  test('a peer cap still downgrades a version that VIOLATES the peer range', async () => {
    // The guard must not over-protect: a pin outside every peer range is genuinely broken and
    // must be capped down. foo@3.9.9 violates the peer `>=1 <3` → capped to the newest in-range.
    latest = { foo: '3.9.9', 'peer-pkg': '1.0.0' };
    versions = { foo: ['1.0.0', '2.5.0', '3.9.9'] };
    peers = { 'peer-pkg': { foo: '>=1 <3' } };
    await writePkg({
      name: 'root',
      devDependencies: { foo: '3.9.9', 'peer-pkg': '1.0.0' },
    });

    await upgradeAllWorkspaces(ctx(), lookups);

    const pkg = await readPackageJson(dir);
    assert.equal(pkg?.devDependencies?.['foo'], '2.5.0', 'violating pin capped down to in-range');
  });

  test('leaves non-pinnable specs (ranges, protocols, tags) untouched', async () => {
    latest = { lit: '3.2.0' };
    await writePkg({
      name: 'root',
      dependencies: { lit: '3.0.0', foo: 'workspace:*', bar: '>=1 <2', baz: 'latest' },
    });

    await upgradeAllWorkspaces(ctx(), lookups);

    const pkg = await readPackageJson(dir);
    assert.deepEqual(pkg?.dependencies, {
      lit: '3.2.0',
      foo: 'workspace:*',
      bar: '>=1 <2',
      baz: 'latest',
    });
  });

  test('caps a pinnable spec to the manifest-declared range for the same package', async () => {
    // `foo` is pinnable in deps but range-declared in peers → cap to the range's newest
    latest = { foo: '3.9.9' };
    versions = { foo: ['1.0.0', '2.5.0', '3.9.9'] };
    await writePkg({
      name: 'root',
      dependencies: { foo: '^1.0.0' },
      peerDependencies: { foo: '>=1 <3' },
    });

    await upgradeAllWorkspaces(ctx(), lookups);

    const pkg = await readPackageJson(dir);
    assert.equal(pkg?.dependencies?.['foo'], '^2.5.0');
    // the range declaration itself is never rewritten
    assert.equal(pkg?.peerDependencies?.['foo'], '>=1 <3');
  });

  test("caps a spec to a dependency's peerDependencies range", async () => {
    // a dep (@enke.dev/lint) peer-pins typescript to 6.0.3; global latest is 7.x
    latest = { typescript: '7.1.0', lit: '3.2.0', '@enke.dev/lint': '0.13.1' };
    versions = { typescript: ['5.9.3', '6.0.3', '7.1.0'] };
    peers = { '@enke.dev/lint': { typescript: '6.0.3' } };
    await writePkg({
      name: 'root',
      dependencies: { lit: '^3.0.0' },
      devDependencies: { '@enke.dev/lint': '0.13.1', typescript: '6.0.3' },
    });

    await upgradeAllWorkspaces(ctx(), lookups);

    const pkg = await readPackageJson(dir);
    // typescript held at the peer-pinned 6.0.3, not bumped to 7.x
    assert.equal(pkg?.devDependencies?.['typescript'], '6.0.3');
    // unconstrained deps still bump to latest
    assert.equal(pkg?.dependencies?.['lit'], '^3.2.0');
  });

  test('intersects OR-ranges from multiple peers correctly, order-independent', async () => {
    // Regression (estino/ui non-idempotent run): two deps peer `release-it` with OR-ranges.
    //   release-it-pnpm   → ^17 || ^18 || ^19   (forbids 20)
    //   conventional-...  → ^18 || ^19 || ^20
    // Correct intersection is ^18 || ^19 → max 19.x. String-joining these flips with operand
    // order and would let release-it jump to 20.2.1, breaking release-it-pnpm's peer.
    latest = {
      'release-it': '20.2.1',
      'release-it-pnpm': '4.6.6',
      '@release-it/conventional-changelog': '11.0.1',
    };
    versions = { 'release-it': ['19.2.4', '20.2.1'] };
    peers = {
      'release-it-pnpm': { 'release-it': '^17.0.0 || ^18.0.0 || ^19.0.0' },
      '@release-it/conventional-changelog': { 'release-it': '^18.0.0 || ^19.0.0 || ^20.0.0' },
    };
    await writePkg({
      name: 'root',
      devDependencies: {
        'release-it': '19.2.4',
        'release-it-pnpm': '4.6.6',
        '@release-it/conventional-changelog': '11.0.1',
      },
    });

    await upgradeAllWorkspaces(ctx(), lookups);

    const pkg = await readPackageJson(dir);
    // held at 19.x — the only version satisfying BOTH peers — never bumped to the forbidden 20.2.1
    assert.equal(pkg?.devDependencies?.['release-it'], '19.2.4');
  });

  test('honors a peer introduced by the version being bumped to (not the installed one)', async () => {
    // Regression (lit-utils ERESOLVE): the installed @enke.dev/lint has no typescript peer, but
    // the version being bumped to adds `typescript@6.0.3`. Peers must be read from the target
    // version so typescript is raised in the SAME run — not left stale for a second run to fix.
    latest = { typescript: '7.1.0', '@enke.dev/lint': '0.13.1' };
    versions = { typescript: ['5.9.3', '6.0.3', '7.1.0'] };
    peers = { '@enke.dev/lint': { typescript: '6.0.3' } }; // peer of the *target* 0.13.1
    await writePkg({
      name: 'root',
      devDependencies: { '@enke.dev/lint': '0.11.25', typescript: '5.9.3' },
    });
    // stale installed manifest: old lint, no typescript peer at all
    const lintDir = join(dir, 'node_modules', '@enke.dev', 'lint');
    await mkdir(lintDir, { recursive: true });
    await writeFile(
      join(lintDir, 'package.json'),
      `${JSON.stringify({ name: '@enke.dev/lint', version: '0.11.25' })}\n`
    );

    await upgradeAllWorkspaces(ctx(), lookups);

    const pkg = await readPackageJson(dir);
    // typescript raised to satisfy the target lint's peer, not held at 5.9.3 or bumped to 7.x
    assert.equal(pkg?.devDependencies?.['typescript'], '6.0.3');
    assert.equal(pkg?.devDependencies?.['@enke.dev/lint'], '0.13.1');
  });

  test('a peer cap never overrides a module-managed dependency', async () => {
    latest = { '@types/node': '24.0.0', '@enke.dev/lint': '0.13.1' };
    versions = { '@types/node': ['22.0.0', '24.0.0'] };
    peers = { '@enke.dev/lint': { '@types/node': '>=20 <23' } };
    await writePkg({
      name: 'root',
      devDependencies: { '@enke.dev/lint': '0.13.1', '@types/node': '24' },
    });

    await upgradeAllWorkspaces(ctx({ managedDependencies: new Set(['@types/node']) }), lookups);

    // types-node owns @types/node, so the peer cap leaves it entirely alone
    assert.equal((await readPackageJson(dir))?.devDependencies?.['@types/node'], '24');
  });

  test('skips module-managed dependencies', async () => {
    latest = { lit: '3.2.0', typescript: '5.9.0' };
    await writePkg({
      name: 'root',
      dependencies: { lit: '^3.0.0', typescript: '5.0.0' },
    });

    await upgradeAllWorkspaces(ctx({ managedDependencies: new Set(['typescript']) }), lookups);

    const pkg = await readPackageJson(dir);
    assert.equal(pkg?.dependencies?.['lit'], '^3.2.0');
    assert.equal(pkg?.dependencies?.['typescript'], '5.0.0');
  });

  test('leaves a spec untouched when the version is unresolvable', async () => {
    latest = { lit: null };
    await writePkg({ name: 'root', dependencies: { lit: '^3.0.0' } });

    await upgradeAllWorkspaces(ctx(), lookups);

    const pkg = await readPackageJson(dir);
    assert.equal(pkg?.dependencies?.['lit'], '^3.0.0');
  });

  test('bumps the root packageManager field to latest', async () => {
    latest = { pnpm: '9.1.0' };
    await writePkg({ name: 'root', packageManager: 'pnpm@8.0.0' });

    await upgradeAllWorkspaces(ctx(), lookups);

    const pkg = await readPackageJson(dir);
    assert.equal(pkg?.packageManager, 'pnpm@9.1.0');
  });

  test('leaves the packageManager field untouched when latest is unresolvable', async () => {
    latest = { pnpm: null };
    await writePkg({ name: 'root', packageManager: 'pnpm@8.0.0' });

    await upgradeAllWorkspaces(ctx(), lookups);

    assert.equal((await readPackageJson(dir))?.packageManager, 'pnpm@8.0.0');
  });

  test('never registry-bumps an npm packageManager field (owned by the npm module, tied to Node)', async () => {
    latest = { npm: '12.0.1' };
    await writePkg({ name: 'root', packageManager: 'npm@10.9.2' });

    await upgradeAllWorkspaces(ctx(), lookups);

    assert.equal((await readPackageJson(dir))?.packageManager, 'npm@10.9.2');
  });

  test('rewrites specs across every workspace member', async () => {
    latest = { lit: '3.2.0' };
    const memberA = await makeTempDir('ws-a');
    const memberB = await makeTempDir('ws-b');
    try {
      await writePackageJson(memberA, { name: 'a', dependencies: { lit: '^3.0.0' } });
      await writePackageJson(memberB, { name: 'b', dependencies: { lit: '~3.1.0' } });

      await upgradeAllWorkspaces(ctx({ workspaces: [memberA, memberB] }), lookups);

      assert.equal((await readPackageJson(memberA))?.dependencies?.['lit'], '^3.2.0');
      assert.equal((await readPackageJson(memberB))?.dependencies?.['lit'], '~3.2.0');
    } finally {
      await rm(memberA, { recursive: true, force: true });
      await rm(memberB, { recursive: true, force: true });
    }
  });

  test('dry-run reports intended work without mutating any manifest', async () => {
    latest = { lit: '3.2.0' };
    const original = `${JSON.stringify({ name: 'root', dependencies: { lit: '^3.0.0' } }, null, 2)}\n`;
    await writeFile(join(dir, 'package.json'), original);

    const out = captureStdout();
    try {
      await upgradeAllWorkspaces(ctx({ dryRun: true }), lookups);
    } finally {
      out.restore();
    }

    // manifest is unchanged and the plan is announced
    assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), original);
    assert.ok(out.output().includes('resolve latest for 1 dependency(ies)'));
  });
});
