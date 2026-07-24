// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
// The network + filesystem are injected, so nothing here touches a real registry or executable.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ReplaceOps } from './self-upgrade.utils.js';
import {
  assetName,
  downloadAsset,
  latestReleaseVersion,
  replaceExecutable,
} from './self-upgrade.utils.js';

describe('assetName', () => {
  test('maps supported os/arch, with .exe on windows', () => {
    assert.equal(assetName({ platform: 'linux', arch: 'x64' }), 'bmpr-linux-x64');
    assert.equal(assetName({ platform: 'darwin', arch: 'arm64' }), 'bmpr-darwin-arm64');
    assert.equal(assetName({ platform: 'win32', arch: 'x64' }), 'bmpr-windows-x64.exe');
  });

  test('null for an unpublished os or arch', () => {
    assert.equal(assetName({ platform: 'freebsd', arch: 'x64' }), null);
    assert.equal(assetName({ platform: 'linux', arch: 'ia32' }), null);
  });
});

describe('latestReleaseVersion', () => {
  test('returns the registry version field', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 });
    assert.equal(await latestReleaseVersion(fetchImpl as unknown as typeof fetch), '1.2.3');
  });

  test('null on a non-ok response or unparseable body', async () => {
    const bad = async () => new Response('', { status: 500 });
    const garbled = async () => new Response('{ not json', { status: 200 });
    assert.equal(await latestReleaseVersion(bad as unknown as typeof fetch), null);
    assert.equal(await latestReleaseVersion(garbled as unknown as typeof fetch), null);
  });
});

describe('downloadAsset', () => {
  test('returns the asset bytes on success', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = async () => new Response(bytes, { status: 200 });
    assert.deepEqual(
      await downloadAsset('1.2.3', 'bmpr-linux-x64', fetchImpl as unknown as typeof fetch),
      bytes
    );
  });

  test('null when the asset is missing (404)', async () => {
    const notFound = async () => new Response('', { status: 404 });
    assert.equal(
      await downloadAsset('1.2.3', 'bmpr-linux-x64', notFound as unknown as typeof fetch),
      null
    );
  });
});

describe('replaceExecutable', () => {
  test('posix: temp write + chmod + atomic rename over the target', async () => {
    const calls: string[][] = [];
    const ops = {
      writeFile: async (p: string) => void calls.push(['write', String(p)]),
      chmod: async (p: string, m: number) => void calls.push(['chmod', String(p), String(m)]),
      rename: async (a: string, b: string) => void calls.push(['rename', a, b]),
    } as unknown as ReplaceOps;

    await replaceExecutable('/usr/local/bin/bmpr', new Uint8Array([1]), false, ops);

    assert.deepEqual(calls, [
      ['write', '/usr/local/bin/bmpr.new'],
      ['chmod', '/usr/local/bin/bmpr.new', String(0o755)],
      ['rename', '/usr/local/bin/bmpr.new', '/usr/local/bin/bmpr'],
    ]);
  });

  test('windows: moves the locked running image aside before renaming in the new one', async () => {
    const renames: string[][] = [];
    const ops = {
      writeFile: async () => undefined,
      chmod: async () => undefined,
      rename: async (a: string, b: string) => void renames.push([a, b]),
    } as unknown as ReplaceOps;

    await replaceExecutable('C:\\bmpr.exe', new Uint8Array([1]), true, ops);

    assert.deepEqual(renames, [
      ['C:\\bmpr.exe', 'C:\\bmpr.exe.old'],
      ['C:\\bmpr.exe.new', 'C:\\bmpr.exe'],
    ]);
  });
});
