import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { BumperConfig, RepoConfig } from '../config/config.types.js';
import { PackageManager } from '../context/context.types.js';
import type { RepoStatus } from './events.js';
import type { RepoRunOptions } from './runner.js';
import type { Runnable } from './scheduler.js';
import type { SessionEvent } from './session.js';
import { ManageSession } from './session.js';
import type { RepoInfo } from './workspace.types.js';

function repo(id: string, published: string[], dependencies: string[]): RepoInfo {
  return {
    id,
    path: `/w/${id}`,
    private: false,
    packageManager: PackageManager.Npm,
    published: published.map(name => ({ name })),
    dependencies,
    branch: 'main',
    branches: ['main'],
    fork: false,
  };
}

const REPOS = [repo('lint', ['@x/lint'], []), repo('utils', ['@x/utils'], ['@x/lint'])];

class FakeRun implements Runnable {
  resolve: (status: RepoStatus) => void = () => undefined;
  constructor(readonly options: RepoRunOptions) {}
  run(): Promise<RepoStatus> {
    this.options.emit({ type: 'status', repo: this.options.repo.id, status: 'updating', at: 1 });
    this.options.emit({
      type: 'log',
      repo: this.options.repo.id,
      stream: 'stdout',
      line: 'hello',
      at: 2,
    });
    return new Promise(resolve => {
      this.resolve = status => {
        this.options.emit({ type: 'status', repo: this.options.repo.id, status, at: 3 });
        resolve(status);
      };
    });
  }
  skipWaiting(): void {
    // nothing waits in the fake
  }
}

function harness(stored: BumperConfig = { repos: {} }) {
  const saved: BumperConfig[] = [];
  const runs = new Map<string, FakeRun>();
  const events: SessionEvent[] = [];
  const session = new ManageSession({
    root: '/w',
    selfCommand: ['bmpr'],
    deps: {
      scan: async root => ({ root, repos: REPOS }),
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      loadConfig: async () => stored,
      saveConfig: async config => {
        saved.push(config);
      },
      createRun: options => {
        const run = new FakeRun(options);
        runs.set(options.repo.id, run);
        return run;
      },
      collectors: [],
      fastCollectors: [],
      now: () => 42,
      logLimit: 2,
    },
  });
  session.on(event => events.push(event));
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
  return { session, saved, runs, events, settle };
}

describe('manage session', () => {
  test('scan builds the view: graph positions, defaults for unconfigured repos', async () => {
    // a stored entry from before the new fields existed
    const stored = { exclude: ['x'], modules: {} } as unknown as RepoConfig;
    const { session, events } = harness({ repos: { '/w/lint': stored } });
    const view = await session.scan();
    assert.deepEqual(view.stages, [['lint'], ['utils']]);
    const lint = view.repos.find(r => r.id === 'lint');
    const utils = view.repos.find(r => r.id === 'utils');
    assert.equal(lint?.configured, true);
    assert.deepEqual(lint?.config.exclude, ['x']);
    assert.equal(lint?.config.waitForRelease, true, 'missing fields filled from the schema');
    assert.equal(utils?.configured, false);
    assert.deepEqual(utils?.upstream, ['lint']);
    assert.equal(utils?.stage, 1);
    assert.equal(events.at(-1)?.type, 'workspace');
  });

  test('updateRepoConfig persists a normalized entry and republishes the view', async () => {
    const { session, saved } = harness();
    await session.scan();
    const view = await session.updateRepoConfig('utils', {
      exclude: [],
      modules: {},
      checks: ['lint'],
      waitForRelease: false,
    });
    assert.deepEqual(saved.at(-1)?.repos['/w/utils']?.checks, ['lint']);
    assert.equal(view.repos.find(r => r.id === 'utils')?.configured, true);
    await assert.rejects(
      () => session.updateRepoConfig('nope', view.repos[0]?.config as never),
      /unknown repo/
    );
  });

  test('a run streams events, records state and caps logs; a second start is refused', async () => {
    const { session, runs, events, settle } = harness();
    await session.scan();
    await session.start({ selection: ['lint', 'utils'] });
    assert.ok(events.some(e => e.type === 'run' && e.running));
    assert.equal(session.running, true);
    await assert.rejects(() => session.start({ selection: ['lint'] }), /already in progress/);
    assert.equal(session.view().repos.find(r => r.id === 'lint')?.status, 'updating');
    assert.deepEqual(
      session.logs('lint').map(l => l.line),
      ['hello']
    );
    assert.deepEqual(runs.get('lint')?.options.allowYoung, []);

    runs.get('lint')?.resolve('done');
    await settle();
    assert.deepEqual(runs.get('utils')?.options.allowYoung, ['@x/lint']);
    runs.get('utils')?.resolve('done');
    await settle();
    assert.equal(session.running, false);
    assert.deepEqual(session.statuses(), { lint: 'done', utils: 'done' });
    assert.equal(events.filter(e => e.type === 'run').at(-1)?.running, false);
  });

  test('retry re-runs a failed repo and clears nothing else', async () => {
    const { session, runs, settle } = harness();
    await session.scan();
    await session.start({ selection: ['lint', 'utils'] });
    runs.get('lint')?.resolve('failed');
    await settle();
    assert.equal(session.view().repos.find(r => r.id === 'utils')?.status, 'blocked');
    runs.delete('lint');
    session.retry('lint');
    assert.ok(runs.has('lint'));
    assert.equal(session.running, true);
  });

  test('diagnose runs the full collector set for one repo and broadcasts it', async () => {
    const { session, events } = harness();
    await session.scan();
    assert.equal(session.view().repos[0]?.diagnosed, false);
    const result = await session.diagnose('lint');
    assert.deepEqual(result, []);
    assert.equal(session.view().repos.find(r => r.id === 'lint')?.diagnosed, true);
    assert.ok(events.some(e => e.type === 'diagnostics' && e.repo === 'lint' && e.diagnosed));
    await assert.rejects(() => session.diagnose('ghost'), /unknown repo/);
  });

  test('start validates the selection', async () => {
    const { session } = harness();
    await assert.rejects(() => session.start({ selection: ['lint'] }), /scan the workspace first/);
    await session.scan();
    await assert.rejects(() => session.start({ selection: ['ghost'] }), /nothing selected/);
  });
});
