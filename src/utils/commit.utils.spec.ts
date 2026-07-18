// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
// The summary + body builders are pure (git plumbing lives elsewhere), so they're driven directly.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isEmptySummary, renderCommitBody, summarizeChanges } from './commit.utils.js';

const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ dependencies: deps, ...extra });

describe('summarizeChanges', () => {
  test('collects changed dependency specs across buckets', () => {
    const before = JSON.stringify({
      dependencies: { react: '^18.2.0', left: '1.0.0' },
      devDependencies: { eslint: '^9.0.0' },
    });
    const after = JSON.stringify({
      dependencies: { react: '^18.3.1', left: '1.0.0' },
      devDependencies: { eslint: '^9.1.0' },
    });
    const s = summarizeChanges([{ path: 'package.json', before, after }]);
    assert.deepEqual(s.deps, [
      { name: 'react', from: '^18.2.0', to: '^18.3.1' },
      { name: 'eslint', from: '^9.0.0', to: '^9.1.0' },
    ]);
  });

  test('ignores unchanged and newly added deps', () => {
    const s = summarizeChanges([
      { path: 'package.json', before: pkg({ a: '1.0.0' }), after: pkg({ a: '1.0.0', b: '2.0.0' }) },
    ]);
    assert.equal(s.deps.length, 0);
  });

  test('dedups identical dep changes across manifests', () => {
    const before = pkg({ typescript: '5.0.0' });
    const after = pkg({ typescript: '5.1.0' });
    const s = summarizeChanges([
      { path: 'package.json', before, after },
      { path: 'packages/a/package.json', before, after },
    ]);
    assert.deepEqual(s.deps, [{ name: 'typescript', from: '5.0.0', to: '5.1.0' }]);
  });

  test('captures the packageManager field change', () => {
    const s = summarizeChanges([
      {
        path: 'package.json',
        before: pkg({}, { packageManager: 'pnpm@9.0.0' }),
        after: pkg({}, { packageManager: 'pnpm@9.1.0' }),
      },
    ]);
    assert.deepEqual(s.packageManager, {
      name: 'packageManager',
      from: 'pnpm@9.0.0',
      to: 'pnpm@9.1.0',
    });
  });

  test('reads .node-version / .bun-version transitions', () => {
    const s = summarizeChanges([
      { path: '.node-version', before: '20.11.0\n', after: '22.15.1\n' },
      { path: '.bun-version', before: '1.1.0\n', after: '1.3.0\n' },
    ]);
    assert.deepEqual(s.node, { name: 'node', from: '20.11.0', to: '22.15.1' });
    assert.deepEqual(s.bun, { name: 'bun', from: '1.1.0', to: '1.3.0' });
  });

  test('diffs pinned action refs in workflows', () => {
    const before =
      'steps:\n  - uses: actions/checkout@aaaa # v4\n  - uses: actions/setup-node@bbbb';
    const after = 'steps:\n  - uses: actions/checkout@cccc # v5\n  - uses: actions/setup-node@bbbb';
    const s = summarizeChanges([{ path: '.github/workflows/ci.yml', before, after }]);
    assert.deepEqual(s.actions, [{ name: 'actions/checkout', from: 'aaaa', to: 'cccc' }]);
  });

  test('unrecognized files fall back to a path list', () => {
    const s = summarizeChanges([
      { path: 'Dockerfile', before: 'FROM node:20', after: 'FROM node:22' },
    ]);
    assert.deepEqual(s.otherFiles, ['Dockerfile']);
  });

  test('a new (before: null) package.json is listed, not dep-diffed', () => {
    const s = summarizeChanges([
      { path: 'package.json', before: null, after: pkg({ a: '1.0.0' }) },
    ]);
    assert.equal(s.deps.length, 0);
    assert.deepEqual(s.otherFiles, ['package.json']);
  });
});

describe('isEmptySummary', () => {
  test('true only when nothing changed', () => {
    assert.equal(isEmptySummary(summarizeChanges([])), true);
    assert.equal(
      isEmptySummary(summarizeChanges([{ path: 'Dockerfile', before: 'a', after: 'b' }])),
      false
    );
  });
});

describe('renderCommitBody', () => {
  test('groups changes under markdown headings', () => {
    const body = renderCommitBody(
      summarizeChanges([
        {
          path: 'package.json',
          before: pkg({ react: '^18.2.0' }),
          after: pkg({ react: '^18.3.1' }),
        },
        { path: '.node-version', before: '20.0.0', after: '22.0.0' },
      ])
    );
    assert.match(body, /### Dependencies/);
    assert.match(body, /- `react`: \^18\.2\.0 → \^18\.3\.1/);
    assert.match(body, /### Node/);
    assert.match(body, /- 20\.0\.0 → 22\.0\.0/);
  });

  test('omits empty sections', () => {
    const body = renderCommitBody(summarizeChanges([{ path: 'x.txt', before: 'a', after: 'b' }]));
    assert.doesNotMatch(body, /### Dependencies/);
    assert.match(body, /### Other/);
  });
});
