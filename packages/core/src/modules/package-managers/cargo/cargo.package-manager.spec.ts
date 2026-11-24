// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
// Drives the cargo module against a tmp crate with the command runner stubbed, so no cargo or
// network is needed.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { contextFor } from '../../../testing/module-context.factory.js';
import { withTempDir } from '../../../testing/with-temp-dir.harness.js';
import type { ExecOptions, ExecResult } from '../../../utils/exec.utils.js';
import { NO_RELEASE_AGE } from '../../../utils/release-age.utils.js';
import { updateCargo } from './cargo.package-manager.js';

// keep the user's own `$CARGO_HOME/config.toml` out of the gate under test
process.env['CARGO_HOME'] = join(tmpdir(), 'bumper-spec-no-cargo-home');

const DRY_RUN_LOG = [
  '    Updating crates.io index',
  ' Downgrading pin-project-lite v0.2.18 -> v0.2.17 (available: v0.2.18, published 5 days ago)',
  '    Updating tokio v1.53.2 -> v1.53.3 (available: v1.54.1, published 34 days ago)',
  '    Updating tauri-plugin-http v2.6.0 -> v2.9.0',
].join('\n');

interface Call {
  cmd: string[];
  opts: ExecOptions | undefined;
}

/** A runner recording every call, answering `cargo --version` and the dry run. */
function stubRunner(cargo = '1.100.0', dryRunLog = DRY_RUN_LOG) {
  const calls: Call[] = [];
  const run = async (cmd: string[], opts?: ExecOptions): Promise<ExecResult> => {
    calls.push({ cmd, opts });
    if (cmd[1] === '--version') {
      return { exitCode: 0, stdout: `cargo ${cargo} (abc 2026-11-05)\n`, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: cmd.includes('--dry-run') ? dryRunLog : '' };
  };
  return { run, calls };
}

/** A tmp repo with one tauri-style crate under `src-tauri`. */
function withCrate(fn: (dir: string, crateDir: string) => Promise<void>): Promise<void> {
  return withTempDir('cargo-pm', async dir => {
    const crateDir = join(dir, 'src-tauri');
    await mkdir(crateDir);
    await writeFile(join(crateDir, 'Cargo.toml'), '[package]\nname = "app"\n');
    await writeFile(join(crateDir, 'Cargo.lock'), 'version = 4\n');
    await fn(dir, crateDir);
  });
}

describe('cargo package manager', () => {
  test('updates only the crates moving forward, under the release age', async () => {
    await withCrate(async (dir, crateDir) => {
      const ctx = { ...contextFor(dir), releaseAge: { ...NO_RELEASE_AGE, seconds: 86400 } };
      const { run, calls } = stubRunner();
      await updateCargo(ctx, run);
      assert.deepEqual(
        calls.map(call => call.cmd.join(' ')),
        [
          'cargo --version',
          'cargo update --dry-run',
          'cargo update -p tokio@1.53.2 -p tauri-plugin-http@2.6.0',
        ]
      );
      // the toolchain is the crate dir's, rustup picks it by the working dir
      assert.equal(calls[0]?.opts?.cwd, crateDir);
      // a full update would roll pin-project-lite back, the targeted one leaves it locked
      calls.slice(1).forEach(call => {
        assert.equal(call.opts?.cwd, crateDir);
        assert.deepEqual(call.opts?.env, {
          CARGO_TERM_COLOR: 'never',
          CARGO_TERM_QUIET: 'false',
          CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE: '86400 seconds',
        });
      });
    });
  });

  test('leaves crates owned by another module alone', async () => {
    await withCrate(async dir => {
      const ctx = { ...contextFor(dir), managedCrates: new Set(['tauri-plugin-http']) };
      const { run, calls } = stubRunner();
      await updateCargo(ctx, run);
      assert.equal(calls.at(-1)?.cmd.join(' '), 'cargo update -p tokio@1.53.2');
    });
  });

  test('without a cooldown any cargo will do, and nothing to move means no update', async () => {
    await withCrate(async dir => {
      const { run, calls } = stubRunner('1.80.0', '    Updating crates.io index\n');
      await updateCargo(contextFor(dir), run);
      assert.deepEqual(
        calls.map(call => call.cmd.join(' ')),
        ['cargo update --dry-run']
      );
    });
  });

  test('refuses a cargo too old to hold the cooldown before touching the lockfile', async () => {
    await withCrate(async dir => {
      const ctx = { ...contextFor(dir), releaseAge: { ...NO_RELEASE_AGE, seconds: 60 } };
      const { run, calls } = stubRunner('1.99.1');
      await assert.rejects(updateCargo(ctx, run), /ignores the release age/);
      assert.equal(calls.length, 1);
    });
  });

  test('skips a dir whose manifest requires a crate younger than the cooldown', async () => {
    await withCrate(async dir => {
      const ctx = { ...contextFor(dir), releaseAge: { ...NO_RELEASE_AGE, seconds: 60 } };
      const calls: string[] = [];
      // verbatim from cargo 1.100 (path shortened)
      const young = [
        'error: failed to select a version for the requirement `serde = "^1.0.229"`',
        '  version 1.0.229 is too new (published 129 days ago, minimum age 200 days)',
        'location searched: crates.io index',
        'required by package `a v0.1.0 (/tmp/a)`',
      ].join('\n');
      const run = async (cmd: string[]): Promise<ExecResult> => {
        calls.push(cmd.join(' '));
        if (cmd[1] === '--version') {
          return { exitCode: 0, stdout: 'cargo 1.100.0 (abc 2026-11-05)\n', stderr: '' };
        }
        throw new Error(young);
      };
      await updateCargo(ctx, run);
      assert.deepEqual(calls, ['cargo --version', 'cargo update --dry-run']);
    });
  });

  test('any other dry-run failure stops the update', async () => {
    await withCrate(async dir => {
      const run = async (): Promise<ExecResult> => {
        throw new Error('error: failed to parse manifest');
      };
      await assert.rejects(updateCargo(contextFor(dir), run), /failed to parse manifest/);
    });
  });

  test('a dry run plans without running cargo', async () => {
    await withCrate(async dir => {
      const { run, calls } = stubRunner();
      await updateCargo(contextFor(dir, true), run);
      assert.equal(calls.length, 0);
    });
  });
});
