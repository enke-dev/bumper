import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PackageManager } from '../context/context.types.js';
import type { RepoStatus, RunEvent } from './events.js';
import { buildGraph } from './graph.js';
import type { Runnable } from './scheduler.js';
import { Scheduler } from './scheduler.js';
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

const REPOS = [
  repo('lint', ['@x/lint'], []),
  repo('utils', ['@x/utils'], ['@x/lint']),
  repo('ui', ['@x/ui'], ['@x/lint', '@x/utils']),
  repo('app', [], ['@x/ui']),
];

/** A run that resolves when the test releases it. */
class FakeRun implements Runnable {
  resolve: (status: RepoStatus) => void = () => undefined;
  skipped = false;
  readonly done = new Promise<RepoStatus>(resolve => {
    this.resolve = resolve;
  });
  run(): Promise<RepoStatus> {
    return this.done;
  }
  skipWaiting(): void {
    this.skipped = true;
  }
}

function harness(selection: string[], ignoreReleaseAge = false) {
  const runs = new Map<string, FakeRun>();
  const allowYoung = new Map<string, string[]>();
  const events: RunEvent[] = [];
  const scheduler = new Scheduler({
    graph: buildGraph(REPOS),
    repos: new Map(REPOS.map(r => [r.id, r])),
    selection,
    ignoreReleaseAge,
    emit: event => events.push(event),
    now: () => 0,
    createRun: (r, allow) => {
      const run = new FakeRun();
      runs.set(r.id, run);
      allowYoung.set(r.id, allow);
      return run;
    },
  });
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
  return { scheduler, runs, allowYoung, events, settle };
}

describe('manage scheduler', () => {
  test('starts roots first and dependents once their selected upstreams are done', async () => {
    const { scheduler, runs, allowYoung, settle } = harness(['lint', 'utils', 'ui', 'app']);
    const idle = scheduler.start();
    assert.deepEqual([...runs.keys()], ['lint']);
    runs.get('lint')?.resolve('done');
    await settle();
    assert.deepEqual([...runs.keys()], ['lint', 'utils']);
    assert.deepEqual(allowYoung.get('utils'), ['@x/lint']);
    runs.get('utils')?.resolve('done');
    await settle();
    assert.deepEqual(allowYoung.get('ui'), ['@x/lint', '@x/utils']);
    runs.get('ui')?.resolve('done');
    await settle();
    runs.get('app')?.resolve('done');
    await idle;
    assert.deepEqual([...scheduler.statuses.values()], ['done', 'done', 'done', 'done']);
  });

  test('unselected upstreams are ignored; independent repos run in parallel', async () => {
    const { scheduler, runs, allowYoung } = harness(['utils', 'ui', 'app']);
    void scheduler.start();
    assert.deepEqual([...runs.keys()], ['utils'], 'ui waits for utils, lint is not selected');
    assert.deepEqual(allowYoung.get('utils'), [], 'lint not selected → nothing allowed young');
  });

  test('ignoreReleaseAge passes every upstream producer, selected or not', async () => {
    const { scheduler, allowYoung } = harness(['utils'], true);
    void scheduler.start();
    assert.deepEqual(allowYoung.get('utils'), ['@x/lint']);
  });

  test('a failure blocks dependents; retry re-queues them; run anyway starts a blocked one', async () => {
    const { scheduler, runs, events, settle } = harness(['lint', 'utils', 'ui']);
    const idle = scheduler.start();
    runs.get('lint')?.resolve('failed');
    await idle;
    assert.equal(scheduler.statuses.get('utils'), 'blocked');
    assert.equal(scheduler.statuses.get('ui'), 'blocked');
    assert.ok(
      events.some(e => e.type === 'status' && e.repo === 'utils' && e.status === 'blocked')
    );

    scheduler.runAnyway('ui');
    assert.ok(runs.has('ui'), 'run anyway launched ui despite blocked upstreams');
    runs.get('ui')?.resolve('done');
    await settle();

    runs.delete('lint');
    scheduler.retry('lint');
    assert.equal(scheduler.statuses.get('utils'), 'queued', 'blocked dependent re-queued');
    assert.ok(runs.has('lint'), 'retry launched lint again');
    runs.get('lint')?.resolve('done');
    await settle();
    assert.ok(runs.has('utils'), 'dependent started after the retried upstream succeeded');
    runs.get('utils')?.resolve('done');
    await scheduler.whenIdle();
    assert.equal(scheduler.statuses.get('utils'), 'done');
  });

  test('skipWaiting reaches the running repo', () => {
    const { scheduler, runs } = harness(['lint']);
    void scheduler.start();
    scheduler.skipWaiting('lint');
    assert.equal(runs.get('lint')?.skipped, true);
  });

  test('a rejected run counts as failed', async () => {
    const events: RunEvent[] = [];
    const scheduler = new Scheduler({
      graph: buildGraph(REPOS),
      repos: new Map(REPOS.map(r => [r.id, r])),
      selection: ['lint', 'utils'],
      emit: event => events.push(event),
      createRun: () => ({
        run: () => Promise.reject(new Error('boom')),
        skipWaiting: () => undefined,
      }),
    });
    await scheduler.start();
    assert.equal(scheduler.statuses.get('lint'), 'failed');
    assert.equal(scheduler.statuses.get('utils'), 'blocked');
  });
});
