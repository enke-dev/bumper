// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
// The network-backed helpers take an injectable executor, so they're driven offline here
// without module mocking (which has no shared cross-runtime API).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PackageManager } from '../context/context.types.js';
import type { ExecResult } from './exec.utils.js';
import { curlJson, latestVersion, latestVersionInRange, viewTool } from './npm-registry.utils.js';

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (): ExecResult => ({ exitCode: 1, stdout: '', stderr: 'boom' });

describe('viewTool', () => {
  test('pnpm repos use pnpm', () => {
    assert.equal(viewTool(PackageManager.Pnpm), 'pnpm');
  });

  test('npm repos use npm', () => {
    assert.equal(viewTool(PackageManager.Npm), 'npm');
  });

  test('bun repos use npm', () => {
    assert.equal(viewTool(PackageManager.Bun), 'npm');
  });
});

describe('curlJson', () => {
  test('parses the JSON body returned by curl', async () => {
    const parsed = await curlJson<{ lts: string; tags: string[] }>(
      'https://example.com/index.json',
      async () => ok('{"lts":"22.15.1","tags":["a","b"]}')
    );
    assert.deepEqual(parsed, { lts: '22.15.1', tags: ['a', 'b'] });
  });

  test('propagates a curl failure', async () => {
    await assert.rejects(
      curlJson('https://example.com/x', async () => {
        throw new Error('curl failed');
      }),
      /curl failed/
    );
  });
});

describe('latestVersion', () => {
  test('returns a bare version from stdout', async () => {
    assert.equal(await latestVersion('lit', 'npm', '/repo', async () => ok('1.2.3\n')), '1.2.3');
  });

  test('takes the last line when the tool prints several', async () => {
    const version = await latestVersion('lit', 'npm', '/repo', async () =>
      ok('npm warn deprecated\n2.4.6\n')
    );
    assert.equal(version, '2.4.6');
  });

  test('returns null on a non-zero exit', async () => {
    assert.equal(await latestVersion('lit', 'npm', '/repo', async () => fail()), null);
  });

  test('returns null when the last line is not a version', async () => {
    const version = await latestVersion('lit', 'npm', '/repo', async () =>
      ok('some warning without a version')
    );
    assert.equal(version, null);
  });

  test('returns null when exec throws', async () => {
    const version = await latestVersion('lit', 'npm', '/repo', async () => {
      throw new Error('spawn error');
    });
    assert.equal(version, null);
  });
});

describe('latestVersionInRange', () => {
  test('returns a bare version for a single match', async () => {
    const version = await latestVersionInRange('lit', '>=1 <2', 'npm', '/repo', async () =>
      ok('1.9.0\n')
    );
    assert.equal(version, '1.9.0');
  });

  test('extracts the version from the last "pkg@x \'x\'" line', async () => {
    const version = await latestVersionInRange('lit', '>=1 <2', 'npm', '/repo', async () =>
      ok("lit@1.2.0 '1.2.0'\nlit@1.4.0 '1.4.0'\n")
    );
    assert.equal(version, '1.4.0');
  });

  test('returns null on a non-zero exit', async () => {
    const version = await latestVersionInRange('lit', '>=1 <2', 'npm', '/repo', async () => fail());
    assert.equal(version, null);
  });

  test('returns null when exec throws', async () => {
    const version = await latestVersionInRange('lit', '>=1 <2', 'npm', '/repo', async () => {
      throw new Error('spawn error');
    });
    assert.equal(version, null);
  });
});
