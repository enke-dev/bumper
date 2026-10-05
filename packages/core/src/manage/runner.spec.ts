// Runtime-agnostic (bun test + node --test). Every process the run would spawn is faked; the repo
// dir is a tmpdir holding just the package.json the check step reads.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { RepoConfig } from '../config/config.types.js';
import { PackageManager } from '../context/context.types.js';
import { makeTempDir } from '../testing/with-temp-dir.harness.js';
import type { ExecResult } from '../utils/exec.utils.js';
import { writePackageJson } from '../utils/fs.utils.js';
import type { RunEvent } from './events.js';
import type { RunnerDeps } from './runner.js';
import { RepoRun } from './runner.js';
import type { RepoInfo } from './workspace.types.js';

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('runner');
  await writePackageJson(dir, { name: 'repo', scripts: { lint: 'eslint .' } });
});

afterEach(() => rm(dir, { recursive: true, force: true }));

const repo = (extra: Partial<RepoInfo> = {}): RepoInfo => ({
  id: 'o/repo',
  path: dir,
  name: 'repo',
  private: false,
  packageManager: PackageManager.Npm,
  published: [{ name: 'repo' }],
  dependencies: [],
  branch: 'main',
  ...extra,
});

const config = (extra: Partial<RepoConfig> = {}): RepoConfig => ({
  exclude: [],
  modules: {},
  checks: ['lint', 'echo free'],
  waitForRelease: true,
  ...extra,
});

interface World {
  dirty: string;
  /** Local branches that exist. */
  branches: string[];
  hasUpstream: boolean;
  /** Whether `bumper update` creates a commit. */
  commits: boolean;
  /** Exit codes per streamed command prefix (default 0). */
  fail: Record<string, number>;
  /** Registry versions, grown by `release()`. */
  versions: string[];
}

function fakes(world: World) {
  const streamed: string[][] = [];
  const state = { head: 'aaa' };
  const exec = async (cmd: string[]): Promise<ExecResult> => {
    const line = cmd.join(' ');
    const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
    const no = (): ExecResult => ({ exitCode: 1, stdout: '', stderr: '' });
    if (line === 'git status --porcelain') {
      return ok(world.dirty);
    }
    if (line === 'git rev-parse --abbrev-ref HEAD') {
      return ok('main');
    }
    if (line === 'git rev-parse --abbrev-ref @{upstream}') {
      return world.hasUpstream ? ok('origin/main') : no();
    }
    if (line === 'git rev-parse HEAD') {
      return ok(state.head);
    }
    if (line.startsWith('git rev-parse --verify --quiet refs/heads/')) {
      return world.branches.includes(cmd[4]?.replace('refs/heads/', '') ?? '') ? ok('x') : no();
    }
    if (line.startsWith('git rev-parse --verify --quiet refs/remotes/')) {
      return no();
    }
    throw new Error(`unexpected query: ${line}`);
  };
  const deps: RunnerDeps = {
    exec,
    stream: async (cmd, { onLine }) => {
      streamed.push(cmd);
      onLine('stdout', `ran ${cmd[0]}`);
      if (cmd.includes('update') && world.commits) {
        state.head = 'bbb';
      }
      const failing = Object.entries(world.fail).find(([prefix]) =>
        cmd.join(' ').startsWith(prefix)
      );
      return failing ? failing[1] : 0;
    },
    lookup: async () => world.versions,
    sleep: async () => undefined,
    now: () => 0,
  };
  return { deps, streamed };
}

function world(extra: Partial<World> = {}): World {
  return {
    dirty: '',
    branches: ['main'],
    hasUpstream: true,
    commits: true,
    fail: {},
    versions: ['1.0.0'],
    ...extra,
  };
}

function statuses(events: RunEvent[]): string[] {
  return events.flatMap(e => (e.type === 'status' ? [e.status] : []));
}

describe('manage runner', () => {
  test('happy path: prepare, update with allow-young, checks, push, wait, done', async () => {
    const w = world();
    const { deps, streamed } = fakes(w);
    const events: RunEvent[] = [];
    const run = new RepoRun(
      {
        repo: repo(),
        config: config(),
        selfCommand: ['bmpr'],
        allowYoung: ['@x/lint'],
        waitTimeoutMs: 60_000,
        emit: e => events.push(e),
      },
      {
        ...deps,
        lookup: async () => (streamed.some(c => c[1] === 'push') ? ['1.0.0', '1.1.0'] : w.versions),
      }
    );
    const status = await run.run();
    assert.equal(status, 'done');
    assert.deepEqual(statuses(events), [
      'preparing',
      'updating',
      'checking',
      'pushing',
      'awaiting-release',
      'done',
    ]);
    assert.equal(run.detail, 'released repo@1.1.0');
    assert.deepEqual(
      streamed.map(c => c.join(' ')),
      [
        'git fetch --quiet',
        'git pull --ff-only --quiet',
        'bmpr update --approve --format --commit --allow-young @x/lint',
        'npm run lint',
        'sh -c echo free',
        'git push --quiet --set-upstream origin main',
      ]
    );
    assert.ok(
      events.some(e => e.type === 'log' && e.line === 'ran bmpr'),
      'child output is logged'
    );
  });

  test('no commit from the update ends the run without checks or push', async () => {
    const { deps, streamed } = fakes(world({ commits: false }));
    const events: RunEvent[] = [];
    const run = new RepoRun(
      {
        repo: repo(),
        config: config(),
        selfCommand: ['bmpr'],
        allowYoung: [],
        waitTimeoutMs: 1,
        emit: e => events.push(e),
      },
      deps
    );
    assert.equal(await run.run(), 'done');
    assert.equal(run.detail, 'nothing to update');
    assert.equal(
      streamed.some(c => c[1] === 'push'),
      false
    );
    assert.deepEqual(statuses(events), ['preparing', 'updating', 'done']);
  });

  test('a dirty work tree fails before anything runs', async () => {
    const { deps, streamed } = fakes(world({ dirty: ' M file' }));
    const run = new RepoRun(
      {
        repo: repo(),
        config: config(),
        selfCommand: ['bmpr'],
        allowYoung: [],
        waitTimeoutMs: 1,
        emit: () => undefined,
      },
      deps
    );
    assert.equal(await run.run(), 'failed');
    assert.match(run.detail ?? '', /uncommitted/);
    assert.deepEqual(streamed, []);
  });

  test('a configured branch that does not exist is created from the current one', async () => {
    const { deps, streamed } = fakes(world({ hasUpstream: false }));
    const run = new RepoRun(
      {
        repo: repo({ published: [], private: true }),
        config: config({ branch: 'chore/deps', checks: [] }),
        selfCommand: ['bmpr'],
        allowYoung: [],
        waitTimeoutMs: 1,
        emit: () => undefined,
      },
      deps
    );
    assert.equal(await run.run(), 'done');
    assert.equal(run.detail, 'pushed');
    assert.deepEqual(
      streamed.map(c => c.join(' ')),
      [
        'git fetch --quiet',
        'git checkout --quiet -b chore/deps',
        'bmpr update --approve --format --commit',
        'git push --quiet --set-upstream origin chore/deps',
      ]
    );
  });

  test('a failing check stops the run before the push', async () => {
    const { deps, streamed } = fakes(world({ fail: { 'npm run lint': 2 } }));
    const run = new RepoRun(
      {
        repo: repo(),
        config: config(),
        selfCommand: ['bmpr'],
        allowYoung: [],
        waitTimeoutMs: 1,
        emit: () => undefined,
      },
      deps
    );
    assert.equal(await run.run(), 'failed');
    assert.equal(run.detail, 'check "lint" failed (exit 2)');
    assert.equal(
      streamed.some(c => c[1] === 'push'),
      false
    );
  });

  test('skipWaiting ends the release wait as done', async () => {
    const { deps } = fakes(world());
    const run = new RepoRun(
      {
        repo: repo(),
        config: config({ checks: [] }),
        selfCommand: ['bmpr'],
        allowYoung: [],
        waitTimeoutMs: 60_000,
        emit: () => undefined,
      },
      {
        ...deps,
        // first poll after the push sees nothing new; the user skips
        lookup: async () => {
          run.skipWaiting();
          return ['1.0.0'];
        },
      }
    );
    assert.equal(await run.run(), 'done');
    assert.equal(run.detail, 'pushed; release wait skipped');
  });

  test('a release that never shows up fails the run', async () => {
    const { deps } = fakes(world());
    const run = new RepoRun(
      {
        repo: repo(),
        config: config({ checks: [] }),
        selfCommand: ['bmpr'],
        allowYoung: [],
        waitTimeoutMs: 1,
        emit: () => undefined,
      },
      deps
    );
    assert.equal(await run.run(), 'failed');
    assert.match(run.detail ?? '', /no new version of repo/);
  });

  test('an unsupported repo fails immediately', async () => {
    const { deps } = fakes(world());
    const run = new RepoRun(
      {
        repo: repo({ packageManager: null, unsupported: 'yarn is not supported yet' }),
        config: config(),
        selfCommand: ['bmpr'],
        allowYoung: [],
        waitTimeoutMs: 1,
        emit: () => undefined,
      },
      deps
    );
    assert.equal(await run.run(), 'failed');
    assert.equal(run.detail, 'yarn is not supported yet');
  });
});
