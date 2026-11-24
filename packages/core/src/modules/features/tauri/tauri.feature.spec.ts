// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
// Drives the tauri feature against a tmp tauri app with cargo and the crates.io index stubbed, so
// no network or Rust toolchain is needed.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { contextFor } from '../../../testing/module-context.factory.js';
import { withTempDir } from '../../../testing/with-temp-dir.harness.js';
import type { ExecOptions, ExecResult } from '../../../utils/exec.utils.js';
import { NO_RELEASE_AGE } from '../../../utils/release-age.utils.js';
import { fittingVersions, tauriFeature, updateTauri } from './tauri.feature.js';

// keep the user's own `$CARGO_HOME/config.toml` out of the gate under test
process.env['CARGO_HOME'] = join(tmpdir(), 'bumper-spec-no-cargo-home');

// verbatim from cargo 1.100 under `registry.global-min-publish-age` (the crate renamed)
const TOO_NEW = [
  'error: failed to select a version for the requirement `tauri-plugin-http = "^2"`',
  '  version 2.9.0 is too new (published 2 days ago, minimum age 7 days)',
  'location searched: crates.io index',
  'help: to use too-new packages anyways, re-resolve with `CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE=allow`',
].join('\n');

// verbatim from cargo 1.100, `--precise` below the manifest's requirement (paths shortened)
const UNMET = [
  'error: failed to select a version for the requirement `tauri-plugin-http = "^2.8"`',
  "candidate versions found which didn't match: 2.7.1",
  'location searched: crates.io index',
  'required by package `app v0.1.0 (/tmp/app)`',
].join('\n');

const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index';

const PACKAGE = {
  dependencies: {
    '@tauri-apps/api': '2.12.5',
    '@tauri-apps/plugin-http': '2.9.0',
    '@tauri-apps/plugin-fs': '^2.7.1',
    '@tauri-apps/plugin-store': '3.0.0',
    '@tauri-apps/plugin-os': '>=2.3 <3',
  },
};

const LOCKED: [string, string][] = [
  ['tauri', '2.12.1'],
  ['tauri-plugin-http', '2.6.0'],
  ['tauri-plugin-fs', '2.7.1'],
  ['tauri-plugin-store', '2.5.1'],
  ['tauri-plugin-os', '2.3.2'],
  ['tauri-plugin-dialog', '2.7.1'],
];

const PUBLISHED: Record<string, string[]> = {
  tauri: ['2.11.0', '2.12.0', '2.12.1', '2.12.7', '2.13.0', '2.13.1-rc.1'],
  'tauri-plugin-http': ['2.5.1', '2.6.0', '2.7.1', '2.8.3', '2.9.0', '3.0.0-alpha.3'],
};

/** A tmp tauri app: a package.json and its `src-tauri` crate. */
function withTauriApp(
  fn: (dir: string, crateDir: string) => Promise<void>,
  locked = LOCKED
): Promise<void> {
  return withTempDir('tauri', async dir => {
    const crateDir = join(dir, 'src-tauri');
    await mkdir(crateDir);
    await writeFile(join(dir, 'package.json'), JSON.stringify(PACKAGE));
    await writeFile(join(crateDir, 'Cargo.toml'), '[package]\nname = "app"\n');
    const blocks = [
      '[[package]]\nname = "app"\nversion = "0.1.0"\n',
      ...locked.map(
        ([name, version]) =>
          `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "${REGISTRY}"\n`
      ),
    ];
    await writeFile(join(crateDir, 'Cargo.lock'), `version = 4\n\n${blocks.join('\n')}`);
    await fn(dir, crateDir);
  });
}

/** The lock fixture with some crates locked elsewhere. */
const lockedWith = (moved: Record<string, string>) =>
  LOCKED.map(([name, version]): [string, string] => [name, moved[name] ?? version]);

interface StubOptions {
  published?: Record<string, string[]>;
  /** The cargo error for an update command, if it fails. */
  fail?: (cmd: string) => string | undefined;
}

/** Stubbed cargo + index, recording the cargo calls. */
function stubDeps(options: StubOptions = {}) {
  const calls: { cmd: string[]; opts: ExecOptions | undefined }[] = [];
  const run = async (cmd: string[], opts?: ExecOptions): Promise<ExecResult> => {
    calls.push({ cmd, opts });
    if (cmd[1] === '--version') {
      return { exitCode: 0, stdout: 'cargo 1.100.0\n', stderr: '' };
    }
    const failure = options.fail?.(cmd.join(' '));
    if (failure !== undefined) {
      throw new Error(`\`${cmd.join(' ')}\` failed (exit 101)\n${failure}`);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const versionsOf = async (crate: string) => (options.published ?? PUBLISHED)[crate] ?? [];
  return { deps: { run, versionsOf }, calls };
}

/** The `cargo update` calls, optionally only those of one crate. */
const updates = (calls: { cmd: string[] }[], crate = '') =>
  calls
    .filter(call => call.cmd[1] === 'update' && (call.cmd[3] ?? '').startsWith(crate))
    .map(call => call.cmd.join(' '));

/** Run with stdout captured, returning what was written. */
async function captured(fn: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let output = '';
  process.stdout.write = ((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return output;
}

describe('fittingVersions', () => {
  test('a plugin crate up to its package, the core crate within its minor, best first', () => {
    const plugin = { pkg: 'p', version: '2.9.0', crate: 'c', match: 'version' } as const;
    assert.deepEqual(
      fittingVersions(['2.6.0', '2.9.0', '2.9.1', '3.0.0-alpha.3', '1.9.9'], plugin),
      ['2.9.0', '2.6.0']
    );
    const core = { pkg: 'p', version: '2.12.5', crate: 'c', match: 'minor' } as const;
    assert.deepEqual(fittingVersions(PUBLISHED['tauri'] ?? [], core), [
      '2.12.7',
      '2.12.1',
      '2.12.0',
    ]);
  });
});

describe('tauri feature', () => {
  test('locks plugin crates to their package, the core crate to the newest of its minor', async () => {
    await withTauriApp(async (dir, crateDir) => {
      const ctx = { ...contextFor(dir), releaseAge: { ...NO_RELEASE_AGE, seconds: 86400 } };
      const { deps, calls } = stubDeps();
      await updateTauri(ctx, deps);
      // fs is a range, store a major apart, os a range, dialog has no package
      assert.deepEqual(updates(calls), [
        'cargo update -p tauri@2.12.1 --precise 2.12.7',
        'cargo update -p tauri-plugin-http@2.6.0 --precise 2.9.0',
      ]);
      const update = calls.find(call => call.cmd[1] === 'update');
      assert.equal(update?.opts?.cwd, crateDir);
      assert.deepEqual(update?.opts?.env, {
        CARGO_TERM_COLOR: 'never',
        CARGO_TERM_QUIET: 'false',
        CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE: '86400 seconds',
      });
    });
  });

  test('takes the newest crate below a version only published for JavaScript', async () => {
    await withTauriApp(async dir => {
      const { deps, calls } = stubDeps({
        published: { ...PUBLISHED, 'tauri-plugin-http': ['2.6.0', '2.8.3'] },
      });
      await updateTauri(contextFor(dir), deps);
      assert.deepEqual(updates(calls, 'tauri-plugin-http'), [
        'cargo update -p tauri-plugin-http@2.6.0 --precise 2.8.3',
      ]);
    });
  });

  test('moves a crate ahead of its package back down', async () => {
    await withTauriApp(
      async dir => {
        const { deps, calls } = stubDeps();
        await updateTauri(contextFor(dir), deps);
        assert.deepEqual(updates(calls), [
          'cargo update -p tauri@2.13.0 --precise 2.12.7',
          'cargo update -p tauri-plugin-http@2.9.1 --precise 2.9.0',
        ]);
      },
      lockedWith({ tauri: '2.13.0', 'tauri-plugin-http': '2.9.1' })
    );
  });

  test('leaves a core crate already on the newest of its minor alone', async () => {
    await withTauriApp(
      async dir => {
        const { deps, calls } = stubDeps();
        await updateTauri(contextFor(dir), deps);
        assert.deepEqual(updates(calls, 'tauri@'), []);
      },
      lockedWith({ tauri: '2.12.7' })
    );
  });

  test('a version younger than the cooldown gives way to the next older one', async () => {
    await withTauriApp(
      async dir => {
        const { deps, calls } = stubDeps({
          fail: cmd => (cmd.endsWith('--precise 2.12.7') ? TOO_NEW : undefined),
        });
        await updateTauri(contextFor(dir), deps);
        assert.deepEqual(updates(calls, 'tauri@'), [
          'cargo update -p tauri@2.13.0 --precise 2.12.7',
          'cargo update -p tauri@2.13.0 --precise 2.12.1',
        ]);
      },
      lockedWith({ tauri: '2.13.0' })
    );
  });

  test('keeps the lock when every newer fitting version is too young', async () => {
    await withTauriApp(async dir => {
      const { deps, calls } = stubDeps({ fail: () => TOO_NEW });
      const output = await captured(() => updateTauri(contextFor(dir), deps));
      // never below the current lock: 2.9.0, 2.8.3 and 2.7.1 are tried, 2.6.0 is the lock
      assert.equal(updates(calls, 'tauri-plugin-http').length, 3);
      assert.match(
        output,
        /tauri-plugin-http fitting @tauri-apps\/plugin-http 2\.9\.0 is younger than the release age, kept 2\.6\.0/
      );
    });
  });

  test('names a crate other than the candidate cargo refused as too young', async () => {
    await withTauriApp(async dir => {
      const { deps } = stubDeps({
        fail: cmd =>
          cmd.includes('tauri-plugin-http')
            ? TOO_NEW.replace('tauri-plugin-http', 'serde')
            : undefined,
      });
      const output = await captured(() => updateTauri(contextFor(dir), deps));
      assert.match(
        output,
        /tauri-plugin-http fitting @tauri-apps\/plugin-http 2\.9\.0 is younger than the release age \(cargo refused serde\), kept 2\.6\.0/
      );
    });
  });

  test("a version below the manifest's requirement keeps the lock, other failures surface", async () => {
    await withTauriApp(async dir => {
      const held = stubDeps({
        fail: cmd => (cmd.includes('tauri-plugin-http') ? UNMET : undefined),
      });
      const output = await captured(() => updateTauri(contextFor(dir), held.deps));
      assert.equal(updates(held.calls, 'tauri-plugin-http').length, 1);
      assert.match(output, /tauri-plugin-http = "\^2\.8" rules out tauri-plugin-http 2\.9\.0/);
      const broken = stubDeps({ fail: () => 'error: failed to load manifest' });
      await assert.rejects(updateTauri(contextFor(dir), broken.deps), /failed to load manifest/);
    });
  });

  test('a core crate on its minor keeps quiet when a newer patch is too young', async () => {
    await withTauriApp(async dir => {
      const { deps, calls } = stubDeps({
        fail: cmd => (cmd.includes('-p tauri@') ? TOO_NEW : undefined),
      });
      const output = await captured(() => updateTauri(contextFor(dir), deps));
      assert.deepEqual(updates(calls, 'tauri@'), ['cargo update -p tauri@2.12.1 --precise 2.12.7']);
      assert.doesNotMatch(output, /tauri fitting/);
    });
  });

  test('says so when no crate on crates.io fits the package', async () => {
    await withTauriApp(async dir => {
      const { deps, calls } = stubDeps({
        published: { ...PUBLISHED, tauri: ['2.11.0', '2.13.0'] },
      });
      const output = await captured(() => updateTauri(contextFor(dir), deps));
      assert.deepEqual(updates(calls, 'tauri@'), []);
      assert.match(output, /no tauri on crates\.io fits @tauri-apps\/api 2\.12\.5, kept 2\.12\.1/);
    });
  });

  test('a dry run plans only the crates that would move, without cargo', async () => {
    await withTauriApp(async dir => {
      const { deps, calls } = stubDeps();
      const output = await captured(() => updateTauri(contextFor(dir, true), deps));
      assert.equal(calls.length, 0);
      assert.match(output, /align tauri 2\.12\.1 with @tauri-apps\/api 2\.12\.5/);
      assert.match(output, /align tauri-plugin-http 2\.6\.0 with @tauri-apps\/plugin-http 2\.9\.0/);
    });
    await withTauriApp(
      async dir => {
        const { deps } = stubDeps();
        const output = await captured(() => updateTauri(contextFor(dir, true), deps));
        assert.doesNotMatch(output, /align tauri /);
      },
      lockedWith({ tauri: '2.12.7' })
    );
  });

  test('applies to a tauri app and owns the pinned crates it can lock', async () => {
    await withTauriApp(async dir => {
      const ctx = contextFor(dir);
      assert.equal(await tauriFeature.isUsed(ctx), true);
      assert.deepEqual((await tauriFeature.managedCrates?.(ctx))?.sort(), [
        'tauri',
        'tauri-plugin-http',
      ]);
      // fs is a caret range and store a major apart, so the cargo update keeps them current
    });
  });
});
