// Runtime-agnostic test: runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { PackageManager } from '../context/context.types.js';
import { withTempDir } from '../testing/with-temp-dir.harness.js';
import type { ExecResult } from './exec.utils.js';
import { resolveFormatCmd, runFormat } from './format.utils.js';

const ok: ExecResult = { exitCode: 0, stdout: '', stderr: '' };

describe('resolveFormatCmd', () => {
  test('returns the package manager run script when a "format" script exists', async () => {
    await withTempDir('fmt-script', async dir => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { format: 'prettier --write .' } })
      );
      const cmd = await resolveFormatCmd(dir, PackageManager.Pnpm);
      assert.deepEqual(cmd, ['pnpm', 'run', 'format']);
    });
  });

  test('uses npm run for npm package manager', async () => {
    await withTempDir('fmt-npm', async dir => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { format: 'x' } }));
      assert.deepEqual(await resolveFormatCmd(dir, PackageManager.Npm), ['npm', 'run', 'format']);
    });
  });

  test('uses bun run for bun package manager', async () => {
    await withTempDir('fmt-bun', async dir => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { format: 'x' } }));
      assert.deepEqual(await resolveFormatCmd(dir, PackageManager.Bun), ['bun', 'run', 'format']);
    });
  });

  test('falls back to local eslint when no format script', async () => {
    await withTempDir('fmt-eslint', async dir => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({}));
      const binDir = join(dir, 'node_modules/.bin');
      await mkdir(binDir, { recursive: true });
      const eslintBin = join(binDir, 'eslint');
      await writeFile(eslintBin, '#!/bin/sh\n');
      // make executable
      const { chmod } = await import('node:fs/promises');
      await chmod(eslintBin, 0o755);
      const cmd = await resolveFormatCmd(dir, PackageManager.Npm);
      assert.deepEqual(cmd, [eslintBin, '--fix', '.']);
    });
  });

  test('falls back to local prettier when no format script and no eslint', async () => {
    await withTempDir('fmt-prettier', async dir => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({}));
      const binDir = join(dir, 'node_modules/.bin');
      await mkdir(binDir, { recursive: true });
      const prettierBin = join(binDir, 'prettier');
      await writeFile(prettierBin, '#!/bin/sh\n');
      const { chmod } = await import('node:fs/promises');
      await chmod(prettierBin, 0o755);
      const cmd = await resolveFormatCmd(dir, PackageManager.Npm, () => false);
      assert.deepEqual(cmd, [prettierBin, '--write', '.']);
    });
  });

  test('returns null when no format script and no formatter binary found', async () => {
    await withTempDir('fmt-none', async dir => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({}));
      const cmd = await resolveFormatCmd(dir, PackageManager.Npm, () => false);
      assert.equal(cmd, null);
    });
  });
});

describe('runFormat', () => {
  test('dry-run prints planned command and does not exec', async () => {
    await withTempDir('fmt-dryrun', async dir => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { format: 'x' } }));
      let execCalled = false;
      const fakeExec = async (): Promise<ExecResult> => {
        execCalled = true;
        return ok;
      };

      let out = '';
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: unknown) => {
        out += String(chunk);
        return true;
      }) as typeof process.stdout.write;

      await runFormat(dir, PackageManager.Npm, true, fakeExec);
      process.stdout.write = orig;

      assert.ok(out.includes('format'), `expected "format" in output, got: ${out}`);
      assert.equal(execCalled, false);
    });
  });

  test('non-dry-run calls exec with the resolved command', async () => {
    await withTempDir('fmt-exec', async dir => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { format: 'x' } }));
      const calls: string[][] = [];
      const fakeExec = async (cmd: string[]): Promise<ExecResult> => {
        calls.push(cmd);
        return ok;
      };
      await runFormat(dir, PackageManager.Pnpm, false, fakeExec);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], ['pnpm', 'run', 'format']);
    });
  });

  test('is a no-op when no format command is resolved', async () => {
    await withTempDir('fmt-noop', async dir => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({}));
      const calls: string[][] = [];
      const fakeExec = async (cmd: string[]): Promise<ExecResult> => {
        calls.push(cmd);
        return ok;
      };
      await runFormat(dir, PackageManager.Npm, false, fakeExec, () => false);
      assert.equal(calls.length, 0);
    });
  });
});
