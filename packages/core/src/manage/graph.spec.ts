import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PackageManager } from '../context/context.types.js';
import { buildGraph, stageOf, transitiveDependents } from './graph.js';
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
    packageManager: PackageManager.Npm,
    published: published.map(name => ({ name })),
    dependencies,
    branch: 'main',
    ...extra,
  };
}

describe('manage graph', () => {
  test('derives edges from published names and layers them into stages', () => {
    const graph = buildGraph([
      repo('lint', ['@x/lint'], []),
      repo('utils', ['@x/utils'], ['@x/lint']),
      repo('ui', ['@x/ui'], ['@x/lint', '@x/utils']),
      repo('app', [], ['@x/ui', 'lit']),
      repo('lonely', [], ['react']),
    ]);
    assert.deepEqual(graph.upstream.get('ui'), ['lint', 'utils']);
    assert.deepEqual(graph.downstream.get('lint'), ['utils', 'ui']);
    assert.deepEqual(graph.stages, [['lint', 'lonely'], ['utils'], ['ui'], ['app']]);
    assert.equal(stageOf(graph, 'app'), 3);
    assert.deepEqual(transitiveDependents(graph, 'lint'), ['app', 'ui', 'utils']);
    assert.deepEqual(graph.cycles, []);
    assert.deepEqual(graph.ambiguous, []);
  });

  test('a name published by two repos is ambiguous and produces no edge', () => {
    const graph = buildGraph([
      repo('a', ['dup'], []),
      repo('b', ['dup'], []),
      repo('c', [], ['dup']),
    ]);
    assert.deepEqual(graph.ambiguous, [{ name: 'dup', repos: ['a', 'b'] }]);
    assert.deepEqual(graph.upstream.get('c'), []);
    assert.equal(graph.producers.has('dup'), false);
  });

  test('cycles land in the last stage and are reported', () => {
    const graph = buildGraph([
      repo('base', ['base'], []),
      repo('x', ['x'], ['y', 'base']),
      repo('y', ['y'], ['x']),
      repo('z', [], ['x']),
    ]);
    assert.deepEqual(graph.stages, [['base'], ['x', 'y', 'z']]);
    assert.deepEqual(graph.cycles, [['x', 'y']]);
  });

  test('a repo depending on its own package is not its own upstream', () => {
    const graph = buildGraph([repo('self', ['self'], ['self'])]);
    assert.deepEqual(graph.upstream.get('self'), []);
    assert.deepEqual(graph.stages, [['self']]);
  });
});
