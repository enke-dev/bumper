import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RepoConfig } from '../config/config.types.js';
import { PackageManager } from '../context/context.types.js';
import type { ExecResult } from '../utils/exec.utils.js';
import { collectDiagnostics } from './diagnostics.js';
import { buildGraph } from './graph.js';
import type { RepoInfo } from './workspace.types.js';

function repo(
  id: string,
  published: string[],
  dependencies: string[],
  extra: Partial<RepoInfo> = {}
): RepoInfo {
  return {
    id,
    path: `/w/${id}`,
    private: false,
    packageManager: PackageManager.Pnpm,
    published: published.map(name => ({ name })),
    dependencies,
    branch: 'main',
    ...extra,
  };
}

const config = (extra: Partial<RepoConfig> = {}): RepoConfig => ({
  exclude: [],
  modules: {},
  checks: ['lint'],
  waitForRelease: true,
  ...extra,
});

/** Fake git/registry answers keyed by the command's first words. */
function fakeRun(answers: Record<string, ExecResult>) {
  return async (cmd: string[]): Promise<ExecResult> => {
    const key = Object.keys(answers).find(prefix => cmd.join(' ').startsWith(prefix));
    return key ? (answers[key] as ExecResult) : { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('manage diagnostics', () => {
  test('a clean, configured repo has nothing to report', async () => {
    const repos = [repo('a', ['a'], [])];
    const found = await collectDiagnostics({
      repo: repos[0] as RepoInfo,
      graph: buildGraph(repos),
      config: config(),
      run: fakeRun({ 'git rev-list': { exitCode: 0, stdout: '0\n', stderr: '' } }),
    });
    assert.deepEqual(found, []);
  });

  test('reports git state, missing checks, branch switch and registry auth', async () => {
    const repos = [repo('a', ['a'], [])];
    const found = await collectDiagnostics({
      repo: repos[0] as RepoInfo,
      graph: buildGraph(repos),
      config: config({ checks: [], branch: 'chore/deps' }),
      run: fakeRun({
        'git status': { exitCode: 0, stdout: ' M x\n', stderr: '' },
        'git rev-list': { exitCode: 0, stdout: '3\n', stderr: '' },
        'pnpm view': { exitCode: 1, stdout: '', stderr: 'ERR_PNPM_FETCH_401 Unauthorized' },
      }),
    });
    assert.deepEqual(found.map(d => d.code).sort(), [
      'behind-remote',
      'branch-switch',
      'dirty-tree',
      'no-checks',
      'registry-auth',
    ]);
    assert.equal(
      found.find(d => d.code === 'behind-remote')?.message,
      '3 commit(s) behind upstream'
    );
  });

  test('reports cycles, ambiguous producers and unsupported repos', async () => {
    const repos = [
      repo('x', ['x', 'dup'], ['y']),
      repo('y', ['y'], ['x']),
      repo('z', ['dup'], [], { packageManager: null, unsupported: 'yarn is not supported yet' }),
    ];
    const graph = buildGraph(repos);
    const x = await collectDiagnostics({
      repo: repos[0] as RepoInfo,
      graph,
      config: config(),
      run: fakeRun({}),
    });
    assert.deepEqual(x.map(d => d.code).sort(), ['ambiguous-producer', 'graph-cycle']);
    assert.equal(x.find(d => d.code === 'graph-cycle')?.message, 'dependency cycle with y');
    const z = await collectDiagnostics({
      repo: repos[2] as RepoInfo,
      graph,
      config: config(),
      run: fakeRun({}),
    });
    assert.deepEqual(z.map(d => d.code).sort(), ['ambiguous-producer', 'unsupported']);
  });

  test('registry auth is only checked when the wait applies', async () => {
    const repos = [repo('a', ['a'], [], { private: true })];
    const found = await collectDiagnostics({
      repo: repos[0] as RepoInfo,
      graph: buildGraph(repos),
      config: config(),
      run: fakeRun({ 'pnpm view': { exitCode: 1, stdout: 'E401', stderr: '' } }),
    });
    assert.deepEqual(found, []);
  });
});
