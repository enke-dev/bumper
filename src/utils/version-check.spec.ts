// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
// The registry lookup takes an injectable executor, so the check is driven offline here.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PackageManager } from '../context/context.types.js';
import type { ExecResult } from './exec.utils.js';
import { checkForSelfUpdate, updateHint } from './version-check.js';

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (): ExecResult => ({ exitCode: 1, stdout: '', stderr: 'boom' });

describe('checkForSelfUpdate', () => {
  test('reports the newer version when current is behind', async () => {
    const latest = await checkForSelfUpdate(PackageManager.Bun, '/repo', '0.1.0', async () =>
      ok('0.4.3\n')
    );
    assert.equal(latest, '0.4.3');
  });

  test('null when current is up to date', async () => {
    const latest = await checkForSelfUpdate(PackageManager.Npm, '/repo', '0.4.3', async () =>
      ok('0.4.3\n')
    );
    assert.equal(latest, null);
  });

  test('null when current is ahead of the registry', async () => {
    const latest = await checkForSelfUpdate(PackageManager.Npm, '/repo', '9.9.9', async () =>
      ok('0.4.3\n')
    );
    assert.equal(latest, null);
  });

  test('null when the lookup fails (offline / private / 404)', async () => {
    const latest = await checkForSelfUpdate(PackageManager.Pnpm, '/repo', '0.1.0', async () =>
      fail()
    );
    assert.equal(latest, null);
  });
});

describe('updateHint', () => {
  test('uses the package manager global-install command', () => {
    assert.match(updateHint(PackageManager.Bun, '0.1.0', '0.4.3'), /bun add -g @enke\.dev\/bumper/);
    assert.match(updateHint(PackageManager.Pnpm, '0.1.0', '0.4.3'), /pnpm add -g/);
    assert.match(updateHint(PackageManager.Npm, '0.1.0', '0.4.3'), /npm i -g/);
  });
});
