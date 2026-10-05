// End-to-end over real git: a bare "origin", a clone with a package.json, a stand-in `bumper`
// script that bumps a dependency and commits, and a fake registry that releases after the push.
// Exercises prepare (fetch, pull), the child update, a real check command, the push and the
// release wait with the real process adapters. Runtime-agnostic (bun test + node --test).
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { PackageManager } from '../context/context.types.js';
import { makeTempDir } from '../testing/with-temp-dir.harness.js';
import { exec, execOk } from '../utils/exec.utils.js';
import type { RunEvent } from './events.js';
import { streamExec } from './exec-stream.js';
import { RepoRun } from './runner.js';
import type { RepoInfo } from './workspace.types.js';

let root: string;
let origin: string;
let clone: string;
let fakeBumper: string;

const git = (cwd: string, ...args: string[]) => execOk(['git', ...args], { cwd });

beforeEach(async () => {
  root = await makeTempDir('runner-e2e');
  origin = join(root, 'origin.git');
  clone = join(root, 'repo');
  await mkdir(origin);
  await git(origin, 'init', '--bare', '--quiet', '--initial-branch=main');
  await git(root, 'clone', '--quiet', origin, clone);
  await git(clone, 'config', 'user.email', 'test@example.com');
  await git(clone, 'config', 'user.name', 'test');
  await writeFile(
    join(clone, 'package.json'),
    JSON.stringify(
      { name: 'repo', version: '1.0.0', dependencies: { '@x/lint': '1.0.0' } },
      null,
      2
    )
  );
  await git(clone, 'add', '-A');
  await git(clone, 'commit', '--quiet', '-m', 'init');
  await git(clone, 'push', '--quiet', '-u', 'origin', 'main');
  // the stand-in: `update …` rewrites the dependency and commits, like `bumper update -c` would
  fakeBumper = join(root, 'bumper');
  await writeFile(
    fakeBumper,
    [
      '#!/bin/sh',
      'set -e',
      'echo "fake bumper $*"',
      'sed -i.bak "s/1.0.0\\"/1.1.0\\"/" package.json && rm package.json.bak',
      'git add -A && git commit --quiet -m "chore: update dependencies"',
    ].join('\n')
  );
  await chmod(fakeBumper, 0o755);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const repo = (): RepoInfo => ({
  id: 'repo',
  path: clone,
  name: 'repo',
  private: false,
  packageManager: PackageManager.Npm,
  published: [{ name: 'repo' }],
  dependencies: ['@x/lint'],
  branch: 'main',
  branches: ['main'],
});

describe('manage runner (e2e, real git)', () => {
  test('updates, checks, pushes to the configured branch and sees the release', async () => {
    const events: RunEvent[] = [];
    const registry = { pushed: false };
    const run = new RepoRun(
      {
        repo: repo(),
        config: {
          exclude: [],
          modules: {},
          branch: 'chore/deps',
          checks: ['test -f package.json'],
          waitForRelease: true,
        },
        selfCommand: [fakeBumper],
        allowYoung: ['@x/lint'],
        waitTimeoutMs: 60_000,
        emit: event => events.push(event),
      },
      {
        stream: streamExec,
        exec,
        lookup: async () => (registry.pushed ? ['1.0.0', '1.1.0'] : ['1.0.0']),
        sleep: async () => {
          registry.pushed = true;
        },
        now: Date.now,
      }
    );
    const status = await run.run();
    assert.equal(status, 'done', run.detail ?? '');
    assert.equal(run.detail, 'released repo@1.1.0');

    const statuses = events.flatMap(e => (e.type === 'status' ? [e.status] : []));
    assert.deepEqual(statuses, [
      'preparing',
      'updating',
      'checking',
      'pushing',
      'awaiting-release',
      'done',
    ]);
    assert.ok(
      events.some(
        e =>
          e.type === 'log' &&
          e.line.includes('fake bumper update --approve --format --commit --allow-young @x/lint')
      ),
      'the child saw the update flags'
    );

    // the branch was created from main and pushed
    const { stdout: branches } = await git(origin, 'branch', '--format=%(refname:short)');
    assert.deepEqual(branches.trim().split('\n').sort(), ['chore/deps', 'main']);
    const { stdout: subject } = await git(origin, 'log', '-1', '--format=%s', 'chore/deps');
    assert.equal(subject.trim(), 'chore: update dependencies');
    const pkg = JSON.parse(await readFile(join(clone, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@x/lint'], '1.1.0');
  });

  test('a dirty clone is refused before anything runs', async () => {
    await writeFile(join(clone, 'scratch.txt'), 'x');
    const run = new RepoRun(
      {
        repo: repo(),
        config: { exclude: [], modules: {}, checks: [], waitForRelease: false },
        selfCommand: [fakeBumper],
        allowYoung: [],
        waitTimeoutMs: 1,
        emit: () => undefined,
      },
      {
        stream: streamExec,
        exec,
        lookup: async () => [],
        sleep: async () => undefined,
        now: Date.now,
      }
    );
    assert.equal(await run.run(), 'failed');
    assert.match(run.detail ?? '', /uncommitted/);
  });
});
