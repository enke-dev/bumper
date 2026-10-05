import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { VersionsLookup } from './release-wait.js';
import { snapshotVersions, waitForRelease } from './release-wait.js';

const pkgs = [{ name: 'a' }, { name: 'b', registry: 'https://npm.pkg.github.com' }];

/** Registry that gains `a@2` on the second poll and `b@2` on the third. */
function registry(): { lookup: VersionsLookup; calls: () => number } {
  const state = { polls: 0 };
  return {
    calls: () => state.polls,
    lookup: async pkg => {
      state.polls += 1;
      const round = Math.ceil(state.polls / 2);
      return pkg.name === 'a' ? (round >= 2 ? ['1', '2'] : ['1']) : round >= 3 ? ['1', '2'] : ['1'];
    },
  };
}

const instant = async (): Promise<void> => undefined;

describe('manage release wait', () => {
  test('snapshot records the versions seen before the push', async () => {
    const before = await snapshotVersions(pkgs, 'npm', '/r', async () => ['1']);
    assert.deepEqual([...(before.get('a') ?? [])], ['1']);
  });

  test('resolves once every package shows a version not in the snapshot', async () => {
    const { lookup } = registry();
    const before = new Map([
      ['a', new Set(['1'])],
      ['b', new Set(['1'])],
    ]);
    const delays: number[] = [];
    const result = await waitForRelease({
      packages: pkgs,
      tool: 'npm',
      cwd: '/r',
      before,
      lookup,
      timeoutMs: 60_000,
      initialDelayMs: 10,
      maxDelayMs: 15,
      sleep: async ms => {
        delays.push(ms);
      },
      now: () => 0,
    });
    assert.deepEqual(result, { outcome: 'released', versions: { a: '2', b: '2' } });
    assert.deepEqual(delays, [10, 15], 'geometric backoff capped at maxDelayMs');
  });

  test('times out with the packages still pending', async () => {
    const clock = { t: 0 };
    const result = await waitForRelease({
      packages: pkgs,
      tool: 'npm',
      cwd: '/r',
      before: new Map([
        ['a', new Set(['1'])],
        ['b', new Set(['1'])],
      ]),
      lookup: async () => ['1'],
      timeoutMs: 100,
      initialDelayMs: 40,
      sleep: async ms => {
        clock.t += ms;
      },
      now: () => clock.t,
    });
    assert.deepEqual(result, { outcome: 'timeout', pending: ['a', 'b'] });
  });

  test('an aborted signal ends the wait as skipped', async () => {
    const controller = new AbortController();
    const result = await waitForRelease({
      packages: pkgs,
      tool: 'npm',
      cwd: '/r',
      before: new Map(),
      lookup: async () => {
        controller.abort();
        return [];
      },
      timeoutMs: 60_000,
      initialDelayMs: 1,
      signal: controller.signal,
      sleep: instant,
      now: () => 0,
    });
    assert.deepEqual(result, { outcome: 'skipped' });
  });

  test('an unresolvable registry answer counts as no new version', async () => {
    const clock = { t: 0 };
    const result = await waitForRelease({
      packages: [{ name: 'a' }],
      tool: 'npm',
      cwd: '/r',
      before: new Map(),
      lookup: async () => null,
      timeoutMs: 5,
      initialDelayMs: 10,
      sleep: async ms => {
        clock.t += ms;
      },
      now: () => clock.t,
    });
    assert.equal(result.outcome, 'timeout');
  });
});
