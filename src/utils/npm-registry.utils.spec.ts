// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
// The network-backed helpers take an injectable executor, so they're driven offline here
// without module mocking (which has no shared cross-runtime API).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PackageManager } from '../context/context.types.js';
import type { ExecResult } from './exec.utils.js';
import {
  curlJson,
  latestEligibleVersion,
  latestVersion,
  latestVersionInRange,
  maxSatisfyingRanges,
  NO_GATE,
  peerDependenciesOf,
  publishTimes,
  viewTool,
} from './npm-registry.utils.js';
import type { ReleaseAgePolicy } from './release-age.utils.js';

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
    const version = await latestVersionInRange('lit', '>=1 <2', 'npm', '/repo', NO_GATE, async () =>
      ok('1.9.0\n')
    );
    assert.equal(version, '1.9.0');
  });

  test('extracts the version from the last "pkg@x \'x\'" line', async () => {
    const version = await latestVersionInRange('lit', '>=1 <2', 'npm', '/repo', NO_GATE, async () =>
      ok("lit@1.2.0 '1.2.0'\nlit@1.4.0 '1.4.0'\n")
    );
    assert.equal(version, '1.4.0');
  });

  test('returns null on a non-zero exit', async () => {
    const version = await latestVersionInRange('lit', '>=1 <2', 'npm', '/repo', NO_GATE, async () =>
      fail()
    );
    assert.equal(version, null);
  });

  test('returns null when exec throws', async () => {
    const version = await latestVersionInRange(
      'lit',
      '>=1 <2',
      'npm',
      '/repo',
      NO_GATE,
      async () => {
        throw new Error('spawn error');
      }
    );
    assert.equal(version, null);
  });
});

describe('maxSatisfyingRanges', () => {
  const VERSIONS = '["17.0.0","18.5.0","19.2.4","20.2.1","6.0.0-beta.1"]';
  const A = '^17.0.0 || ^18.0.0 || ^19.0.0'; // forbids 20
  const B = '^18.0.0 || ^19.0.0 || ^20.0.0';

  test('intersects OR-ranges correctly (highest satisfying ALL), order-independent', async () => {
    const forward = await maxSatisfyingRanges(
      'release-it',
      [A, B],
      'npm',
      '/repo',
      NO_GATE,
      async () => ok(VERSIONS)
    );
    const reversed = await maxSatisfyingRanges(
      'release-it',
      [B, A],
      'npm',
      '/repo',
      NO_GATE,
      async () => ok(VERSIONS)
    );
    // both orders yield 19.2.4 — the string-join bug would let one order pick the forbidden 20.2.1
    assert.equal(forward, '19.2.4');
    assert.equal(reversed, '19.2.4');
  });

  test('returns the single highest version satisfying one range', async () => {
    const version = await maxSatisfyingRanges(
      'release-it',
      [B],
      'npm',
      '/repo',
      NO_GATE,
      async () => ok(VERSIONS)
    );
    assert.equal(version, '20.2.1');
  });

  test('excludes prereleases', async () => {
    const version = await maxSatisfyingRanges(
      'pkg',
      ['>=6.0.0-0 <7'],
      'npm',
      '/repo',
      NO_GATE,
      async () => ok('["6.0.0-beta.1","6.0.0"]')
    );
    assert.equal(version, '6.0.0');
  });

  test('handles a package with a single published version (bare string, not array)', async () => {
    const version = await maxSatisfyingRanges(
      'pkg',
      ['^4.0.0'],
      'npm',
      '/repo',
      NO_GATE,
      async () => ok('"4.6.6"')
    );
    assert.equal(version, '4.6.6');
  });

  test('returns null when nothing satisfies every range', async () => {
    const version = await maxSatisfyingRanges(
      'pkg',
      ['^17.0.0', '^20.0.0'],
      'npm',
      '/repo',
      NO_GATE,
      async () => ok(VERSIONS)
    );
    assert.equal(version, null);
  });

  test('returns null for an empty range list without querying', async () => {
    let called = false;
    const version = await maxSatisfyingRanges('pkg', [], 'npm', '/repo', NO_GATE, async () => {
      called = true;
      return ok(VERSIONS);
    });
    assert.equal(version, null);
    assert.equal(called, false);
  });

  test('returns null on a non-zero exit', async () => {
    assert.equal(
      await maxSatisfyingRanges('pkg', ['^1'], 'npm', '/repo', NO_GATE, async () => fail()),
      null
    );
  });

  test('returns null when exec throws', async () => {
    const version = await maxSatisfyingRanges('pkg', ['^1'], 'npm', '/repo', NO_GATE, async () => {
      throw new Error('spawn error');
    });
    assert.equal(version, null);
  });
});

describe('peerDependenciesOf', () => {
  test('parses the peerDependencies JSON object for a version', async () => {
    const peers = await peerDependenciesOf('@enke.dev/lint', '0.13.1', 'npm', '/repo', async () =>
      ok('{"typescript":"6.0.3","eslint":"^10.7.0"}\n')
    );
    assert.deepEqual(peers, { typescript: '6.0.3', eslint: '^10.7.0' });
  });

  test('returns an empty object when the version declares no peers (empty stdout)', async () => {
    const peers = await peerDependenciesOf('lit', '3.2.0', 'npm', '/repo', async () => ok('\n'));
    assert.deepEqual(peers, {});
  });

  test('returns an empty object on a non-zero exit', async () => {
    assert.deepEqual(
      await peerDependenciesOf('lit', '3.2.0', 'npm', '/repo', async () => fail()),
      {}
    );
  });

  test('returns an empty object when stdout is not a JSON object (e.g. an array)', async () => {
    const peers = await peerDependenciesOf('lit', '3.2.0', 'npm', '/repo', async () =>
      ok('["a","b"]')
    );
    assert.deepEqual(peers, {});
  });

  test('returns an empty object when exec throws', async () => {
    const peers = await peerDependenciesOf('lit', '3.2.0', 'npm', '/repo', async () => {
      throw new Error('spawn error');
    });
    assert.deepEqual(peers, {});
  });
});

const NOW = Date.parse('2026-09-14T12:00:00Z');
const HOUR = 3_600_000;

/** A `view` executor answering `version`, `version time`, `versions --json` and `time --json`
 * from one fixture — the same shapes npm/pnpm return. */
function registry(latest: string, times: Record<string, string>) {
  const time = { created: '2020-01-01T00:00:00Z', ...times };
  return async (cmd: string[]): Promise<ExecResult> => {
    if (cmd.includes('version') && cmd.includes('time')) {
      return ok(JSON.stringify({ version: latest, time }));
    }
    if (cmd.includes('time')) {
      return ok(JSON.stringify(time));
    }
    if (cmd.includes('versions')) {
      return ok(JSON.stringify(Object.keys(times)));
    }
    return ok(`${latest}\n`);
  };
}

const gate = (seconds: number, excludes: string[] = [], extra: Partial<ReleaseAgePolicy> = {}) => ({
  policy: {
    seconds,
    excludes,
    strict: true,
    ignoreMissingTime: true,
    source: 'test',
    ...extra,
  } satisfies ReleaseAgePolicy,
  now: NOW,
});

const TIMES = {
  '1.0.0': new Date(NOW - 40 * HOUR).toISOString(),
  '1.1.0': new Date(NOW - 30 * HOUR).toISOString(),
  '1.2.0': new Date(NOW - 2 * HOUR).toISOString(),
};

describe('publishTimes', () => {
  test('drops the non-version keys and parses timestamps', async () => {
    const times = await publishTimes('lit', 'npm', '/repo', registry('1.2.0', TIMES));
    assert.deepEqual(Object.keys(times), ['1.0.0', '1.1.0', '1.2.0']);
    assert.equal(times['1.2.0'], Date.parse(TIMES['1.2.0']));
  });

  test('is empty when the tool fails', async () => {
    assert.deepEqual(await publishTimes('lit', 'npm', '/repo', async () => fail()), {});
  });
});

describe('latestEligibleVersion', () => {
  test('returns latest untouched without a gate — and never calls the registry twice', async () => {
    const calls: string[][] = [];
    const version = await latestEligibleVersion('lit', 'npm', '/repo', NO_GATE, async cmd => {
      calls.push(cmd);
      return ok('1.2.0\n');
    });
    assert.equal(version, '1.2.0');
    assert.equal(calls.length, 1);
  });

  test('resolves version + times in a single registry call under a gate', async () => {
    const calls: string[][] = [];
    const answer = registry('1.2.0', TIMES);
    const version = await latestEligibleVersion('lit', 'npm', '/repo', gate(86_400), async cmd => {
      calls.push(cmd);
      return answer(cmd);
    });
    assert.equal(version, '1.1.0');
    assert.equal(calls.length, 1);
  });

  test('returns latest when it already cleared the cooldown', async () => {
    const version = await latestEligibleVersion(
      'lit',
      'npm',
      '/repo',
      gate(HOUR / 1000),
      registry('1.2.0', TIMES)
    );
    assert.equal(version, '1.2.0');
  });

  test('walks back to the newest version past the cooldown', async () => {
    const version = await latestEligibleVersion(
      'lit',
      'npm',
      '/repo',
      gate(86_400),
      registry('1.2.0', TIMES)
    );
    assert.equal(version, '1.1.0');
  });

  test('an exempt package keeps the fresh latest', async () => {
    const version = await latestEligibleVersion(
      'lit',
      'npm',
      '/repo',
      gate(86_400, ['lit']),
      registry('1.2.0', TIMES)
    );
    assert.equal(version, '1.2.0');
  });

  test('an unknown publish time is eligible by default', async () => {
    const version = await latestEligibleVersion(
      'lit',
      'npm',
      '/repo',
      gate(86_400),
      registry('9.9.9', TIMES)
    );
    assert.equal(version, '9.9.9');
  });

  test('ignoreMissingTime: false blocks a version without a publish time', async () => {
    const version = await latestEligibleVersion(
      'lit',
      'npm',
      '/repo',
      gate(86_400, [], { ignoreMissingTime: false }),
      registry('9.9.9', TIMES)
    );
    assert.equal(version, '1.1.0');
  });

  test('a strict gate leaves the dependency alone when nothing cleared the cooldown', async () => {
    const version = await latestEligibleVersion(
      'lit',
      'npm',
      '/repo',
      gate(10 * 365 * 86_400),
      registry('1.2.0', TIMES)
    );
    assert.equal(version, null);
  });

  test('a non-strict gate falls back to the blocked version, like pnpm does', async () => {
    const version = await latestEligibleVersion(
      'lit',
      'npm',
      '/repo',
      gate(10 * 365 * 86_400, [], { strict: false }),
      registry('1.2.0', TIMES)
    );
    assert.equal(version, '1.2.0');
  });
});

describe('latestVersionInRange with a gate', () => {
  test('stays inside the range while walking back', async () => {
    const version = await latestVersionInRange(
      'lit',
      '1.x',
      'npm',
      '/repo',
      gate(86_400),
      registry('1.2.0', TIMES)
    );
    assert.equal(version, '1.1.0');
  });
});

describe('maxSatisfyingRanges with a gate', () => {
  test('skips a match that is still within the cooldown', async () => {
    const version = await maxSatisfyingRanges(
      'lit',
      ['^1.0.0'],
      'npm',
      '/repo',
      gate(86_400),
      registry('1.2.0', TIMES)
    );
    assert.equal(version, '1.1.0');
  });
});
