// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import type { ModuleContext } from '../context/context.types.js';
import { PackageManager } from '../context/context.types.js';
import { withTempDir } from '../testing/with-temp-dir.harness.js';
import {
  approveScripts,
  cleanInstall,
  installWithRetry,
  isPropagationLag,
  selfUpdate,
} from './deps.utils.js';

function ctx(overrides: Partial<ModuleContext> = {}): ModuleContext {
  return { cwd: '/nonexistent-bumper-cwd', dryRun: true, ...overrides } as ModuleContext;
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

let out: ReturnType<typeof captureStdout>;
afterEach(() => out?.restore());

describe('cleanInstall', () => {
  test('dry-run plans removing node_modules + the lockfile and the install, without touching the fs', async () => {
    out = captureStdout();
    await cleanInstall(ctx({ packageManager: PackageManager.Npm }), ['npm', 'install']);
    assert.ok(out.output().includes('rm -rf node_modules'));
    assert.ok(out.output().includes('package-lock.json'));
    assert.ok(out.output().includes('npm install'));
    // lifecycle scripts are skipped: only the resolved lockfile matters, and prepare/postinstall
    // hooks routinely fail in a bare CI checkout (missing tokens, unbuilt dist)
    assert.ok(out.output().includes('--ignore-scripts'));
    // the second, convergence pass is signposted so the plan doesn't read as a single install
    assert.ok(out.output().includes('twice'));
  });

  test('removes the stale lockfile before reinstalling (real fs, no-op install)', async () => {
    await withTempDir('clean', async dir => {
      const lockfile = join(dir, 'package-lock.json');
      await writeFile(lockfile, '{"lockfileVersion":3}\n');
      // `true` is a real, always-present binary → the install step is a harmless no-op.
      await cleanInstall(ctx({ dryRun: false, cwd: dir, packageManager: PackageManager.Npm }), [
        'true',
      ]);
      assert.equal(existsSync(lockfile), false, 'stale package-lock.json is removed');
    });
  });

  test('runs the install twice so a from-scratch resolve settles the lockfile', async () => {
    await withTempDir('clean-twice', async dir => {
      // an install script that appends one line per invocation; the file's line count is the count.
      const counter = join(dir, 'runs');
      const script = join(dir, 'install.sh');
      await writeFile(script, `#!/bin/sh\necho run >> "${counter}"\n`);
      await chmod(script, 0o755);
      await cleanInstall(ctx({ dryRun: false, cwd: dir, packageManager: PackageManager.Npm }), [
        script,
      ]);
      const runs = (await readFile(counter, 'utf8')).trim().split('\n');
      assert.equal(runs.length, 2, 'install command runs exactly twice');
    });
  });
});

describe('isPropagationLag', () => {
  test('matches each package manager\'s "published but not served yet" failure', () => {
    assert.equal(isPropagationLag(new Error('Error: ERR_PNPM_NO_MATCHING_VERSION')), true);
    assert.equal(isPropagationLag(new Error('npm error code ETARGET')), true);
    assert.equal(isPropagationLag('error: No version matching "8.70.0" found'), true);
  });

  test('ignores unrelated install failures', () => {
    assert.equal(isPropagationLag(new Error('ERR_PNPM_PEER_DEP_ISSUES')), false);
    assert.equal(isPropagationLag(new Error('npm error code ERESOLVE')), false);
  });
});

describe('installWithRetry', () => {
  test('retries once when the registry has not served a bumped version yet', async () => {
    await withTempDir('retry', async dir => {
      // fails with pnpm's lag code on the first run, succeeds afterwards
      const counter = join(dir, 'runs');
      const script = join(dir, 'install.sh');
      await writeFile(
        script,
        `#!/bin/sh\necho run >> "${counter}"\n` +
          `test "$(wc -l < "${counter}")" -gt 1 && exit 0\n` +
          'echo "Error: ERR_PNPM_NO_MATCHING_VERSION" >&2\nexit 1\n'
      );
      await chmod(script, 0o755);
      out = captureStdout();
      await installWithRetry([script], dir, 0);
      const runs = (await readFile(counter, 'utf8')).trim().split('\n');
      assert.equal(runs.length, 2, 'install runs a second time after the lag failure');
      assert.ok(out.output().includes('retrying install'), 'the retry is announced');
    });
  });

  test('fails fast on an unrelated install failure', async () => {
    await withTempDir('no-retry', async dir => {
      const counter = join(dir, 'runs');
      const script = join(dir, 'install.sh');
      await writeFile(
        script,
        `#!/bin/sh\necho run >> "${counter}"\necho "npm error code ERESOLVE" >&2\nexit 1\n`
      );
      await chmod(script, 0o755);
      await assert.rejects(installWithRetry([script], dir, 0), /ERESOLVE/);
      const runs = (await readFile(counter, 'utf8')).trim().split('\n');
      assert.equal(runs.length, 1, 'no retry for a genuine resolution failure');
    });
  });
});

describe('approveScripts', () => {
  test('dry-run plans the command', async () => {
    out = captureStdout();
    await approveScripts(ctx(), ['npm', 'approve-scripts', '--all']);
    assert.ok(out.output().includes('npm approve-scripts --all'));
  });

  test('is a no-op for an empty command (managers without a bulk-approve command, e.g. bun)', async () => {
    out = captureStdout();
    assert.equal(await approveScripts(ctx({ dryRun: false }), []), undefined);
    assert.equal(out.output(), '');
  });

  test('is a no-op for a missing binary (non-fatal)', async () => {
    out = captureStdout();
    assert.equal(
      await approveScripts(ctx({ dryRun: false }), ['this-binary-does-not-exist-xyz', '--all']),
      undefined
    );
    assert.equal(out.output(), '');
  });
});

describe('selfUpdate', () => {
  test('dry-run plans the command', async () => {
    out = captureStdout();
    await selfUpdate(ctx(), ['pnpm', 'self-update']);
    assert.ok(out.output().includes('pnpm self-update'));
  });

  test('is a no-op for a missing binary (non-fatal)', async () => {
    out = captureStdout();
    // real (non-dry) path: unresolvable binary short-circuits before any exec
    assert.equal(
      await selfUpdate(ctx({ dryRun: false }), ['this-binary-does-not-exist-xyz', 'update']),
      undefined
    );
    assert.equal(out.output(), '');
  });

  test('is a no-op for an empty command', async () => {
    assert.equal(await selfUpdate(ctx({ dryRun: false }), []), undefined);
  });
});
