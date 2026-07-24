// Runtime-agnostic test (node:test + node:assert): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { partitionByOwnership } from './docker-refs.utils.js';

describe('partitionByOwnership', () => {
  test('owned repos are held back across spellings; same name under another registry is not', () => {
    const { owned, candidates } = partitionByOwnership(
      ['node:22', 'library/node:20', 'postgres:16', 'ghcr.io/x/node:1'],
      new Set(['node'])
    );
    assert.deepEqual(owned, ['node:22', 'library/node:20']);
    assert.deepEqual(candidates, ['postgres:16', 'ghcr.io/x/node:1']);
  });
});
