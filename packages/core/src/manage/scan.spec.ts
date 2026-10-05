import assert from 'node:assert/strict';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { PackageManager } from '../context/context.types.js';
import { makeTempDir } from '../testing/with-temp-dir.harness.js';
import type { ExecResult } from '../utils/exec.utils.js';
import { findRepos, githubSlug, scanWorkspace } from './scan.js';

let root: string;

async function gitRepo(
  path: string,
  pkg?: object,
  files: Record<string, string> = {}
): Promise<void> {
  await mkdir(join(root, path, '.git'), { recursive: true });
  if (pkg) {
    await writeFile(join(root, path, 'package.json'), JSON.stringify(pkg));
  }
  await Promise.all(
    Object.entries(files).map(async ([name, body]) => {
      await mkdir(join(root, path, name, '..'), { recursive: true });
      await writeFile(join(root, path, name), body);
    })
  );
}

const run = async (cmd: string[]): Promise<ExecResult> =>
  cmd[1] === 'remote'
    ? { exitCode: 0, stdout: 'git@github.com:me/plain.git\n', stderr: '' }
    : cmd[1] === 'rev-parse'
      ? { exitCode: 0, stdout: 'main\n', stderr: '' }
      : cmd[1] === 'branch'
        ? { exitCode: 0, stdout: 'main\nchore/deps\n', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: '' };

beforeEach(async () => {
  root = await makeTempDir('scan');
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe('manage scan', () => {
  test('finds nested repos, stops at .git, skips hidden and node_modules dirs', async () => {
    await gitRepo('owner/a', { name: 'a' });
    await gitRepo('owner/a/vendored', { name: 'inner' });
    await gitRepo('owner/b');
    await gitRepo('.hidden/c', { name: 'c' });
    await gitRepo('node_modules/d', { name: 'd' });
    const found = await findRepos(root);
    assert.deepEqual(found, [join(root, 'owner/a'), join(root, 'owner/b')]);
  });

  test('describes manifests, workspaces, published names and dependencies', async () => {
    await gitRepo(
      'o/mono',
      { name: 'mono', private: true, workspaces: ['packages/*'], devDependencies: { eslint: '1' } },
      {
        'packages/lib/package.json': JSON.stringify({
          name: '@o/lib',
          publishConfig: { registry: 'https://npm.pkg.github.com' },
          dependencies: { lit: '3' },
        }),
        'packages/app/package.json': JSON.stringify({
          name: '@o/app',
          private: true,
          dependencies: { '@o/lib': '1' },
        }),
        'bun.lock': '',
      }
    );
    await gitRepo(
      'o/plain',
      { name: 'plain', dependencies: { '@o/lib': '1' } },
      { 'yarn.lock': '' }
    );
    await gitRepo('o/empty');
    const { repos } = await scanWorkspace(root, run);
    const mono = repos.find(r => r.id === 'o/mono');
    assert.equal(mono?.packageManager, PackageManager.Bun);
    assert.equal(mono?.private, true);
    assert.deepEqual(mono?.published, [{ name: '@o/lib', registry: 'https://npm.pkg.github.com' }]);
    assert.deepEqual(mono?.dependencies.sort(), ['@o/lib', 'eslint', 'lit']);
    assert.equal(mono?.branch, 'main');
    assert.deepEqual(mono?.branches, ['main', 'chore/deps']);

    const plain = repos.find(r => r.id === 'o/plain');
    assert.equal(plain?.packageManager, null);
    assert.equal(plain?.unsupported, 'yarn is not supported yet');
    assert.deepEqual(plain?.published, [{ name: 'plain' }]);

    const empty = repos.find(r => r.id === 'o/empty');
    assert.equal(empty?.unsupported, 'no package.json');
    assert.equal(empty?.packageManager, null);
  });

  test('follows symlinked directories once and survives loops', async () => {
    await gitRepo('real/a', { name: 'a' });
    await symlink(join(root, 'real'), join(root, 'linked'));
    await symlink(root, join(root, 'real/loop'));
    const found = await findRepos(root);
    // reached via `linked/a` or `real/a`, whichever sorts first — but exactly once
    assert.equal(found.length, 1);
    assert.equal(await realpath(found[0] as string), await realpath(join(root, 'real/a')));
  });

  test('a manifest pointing at another GitHub owner than origin marks a fork', async () => {
    await gitRepo('o/plain', { name: 'plain', repository: 'github:upstream/plain' });
    await gitRepo('o/own', {
      name: 'own',
      repository: { url: 'git+https://github.com/me/plain.git' },
    });
    const { repos } = await scanWorkspace(root, run);
    assert.equal(repos.find(r => r.id === 'o/plain')?.fork, true);
    assert.equal(repos.find(r => r.id === 'o/own')?.fork, false);
    assert.equal(githubSlug('https://github.com/A/B#readme'), 'a/b');
    assert.equal(githubSlug('https://gitlab.com/a/b'), null);
  });

  test('the root itself may be a repo', async () => {
    await gitRepo('.', { name: 'solo' });
    const { repos } = await scanWorkspace(root, run);
    assert.deepEqual(
      repos.map(r => r.id),
      ['.']
    );
  });
});
