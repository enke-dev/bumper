// Runtime-agnostic test: runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { PackageManager } from '../context/context.types.js';
import { withTempDir } from '../testing/with-temp-dir.harness.js';
import type { ExecResult } from './exec.utils.js';
import { exec } from './exec.utils.js';
import { resolveFormatCmd, runFormat } from './format.utils.js';
import { pathExists } from './fs.utils.js';

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

  test('falls back to global eslint when no local binaries exist', async () => {
    await withTempDir('fmt-global-eslint', async dir => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({}));
      const cmd = await resolveFormatCmd(dir, PackageManager.Npm, tool => tool === 'eslint');
      assert.deepEqual(cmd, ['eslint', '--fix', '.']);
    });
  });

  test('falls back to global prettier when no local binaries and no global eslint', async () => {
    await withTempDir('fmt-global-prettier', async dir => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({}));
      const cmd = await resolveFormatCmd(dir, PackageManager.Npm, tool => tool === 'prettier');
      assert.deepEqual(cmd, ['prettier', '--write', '.']);
    });
  });

  test('local prettier is preferred over global eslint', async () => {
    await withTempDir('fmt-local-prettier-over-global-eslint', async dir => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({}));
      const binDir = join(dir, 'node_modules/.bin');
      await mkdir(binDir, { recursive: true });
      const prettierBin = join(binDir, 'prettier');
      await writeFile(prettierBin, '#!/bin/sh\n');
      const { chmod } = await import('node:fs/promises');
      await chmod(prettierBin, 0o755);
      // global eslint is available, but local prettier should win
      const cmd = await resolveFormatCmd(dir, PackageManager.Npm, tool => tool === 'eslint');
      assert.deepEqual(cmd, [prettierBin, '--write', '.']);
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
      // besides the git probe (not a repo here → no scoping), exactly the format command runs
      const formatCalls = calls.filter(cmd => cmd[0] !== 'git');
      assert.equal(formatCalls.length, 1);
      assert.deepEqual(formatCalls[0], ['pnpm', 'run', 'format']);
    });
  });

  test('reverts formatter edits to files the update never touched (git repo)', async () => {
    await withTempDir('fmt-scope', async dir => {
      const git = (...args: string[]) => exec(['git', ...args], { cwd: dir });
      await writeFile(join(dir, 'package.json'), '{"scripts":{"format":"x"}}\n');
      await mkdir(join(dir, '.github/workflows'), { recursive: true });
      await writeFile(join(dir, '.github/workflows/ci.yml'), 'on:   push\n');
      await git('init', '-q');
      await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
      await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
      // the update's own change: package.json rewritten (unformatted)
      await writeFile(join(dir, 'package.json'), '{"scripts":{"format":"x"},"version":"2"}\n');

      // git commands run for real; the "formatter" reformats package.json AND the workflow file,
      // and drops a stray report file
      const run = async (cmd: string[], opts?: { cwd?: string }): Promise<ExecResult> => {
        if (cmd[0] === 'git') {
          return exec(cmd, opts);
        }
        await writeFile(
          join(dir, 'package.json'),
          '{ "scripts": { "format": "x" }, "version": "2" }\n'
        );
        await writeFile(join(dir, '.github/workflows/ci.yml'), 'on: push\n');
        await writeFile(join(dir, 'report.txt'), 'formatted 2 files\n');
        return ok;
      };
      await runFormat(dir, PackageManager.Npm, false, run);

      const { readFile } = await import('node:fs/promises');
      // touched by the update → formatter result kept
      assert.equal(
        await readFile(join(dir, 'package.json'), 'utf8'),
        '{ "scripts": { "format": "x" }, "version": "2" }\n'
      );
      // untouched by the update → formatter edit reverted to HEAD
      assert.equal(await readFile(join(dir, '.github/workflows/ci.yml'), 'utf8'), 'on:   push\n');
      // created by the formatter → removed
      assert.equal(await pathExists(join(dir, 'report.txt')), false);
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
