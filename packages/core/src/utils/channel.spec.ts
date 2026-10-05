// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
// `installChannel` reads a compile-time constant (`__BUMPER_CHANNEL__`, baked by `bun build
// --define`), so the binary path can't be exercised without a real build — the branching lives in
// the pure `channelFrom`, tested exhaustively here. `installChannel` is thin glue that resolves to
// `managed` in dev/test, where the marker is undefined.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { channelFrom, installChannel } from './channel.js';

describe('channelFrom', () => {
  test("'binary' only for the exact baked marker", () => {
    assert.equal(channelFrom('binary'), 'binary');
  });

  test('managed when undefined or anything else (the safe default)', () => {
    assert.equal(channelFrom(undefined), 'managed');
    assert.equal(channelFrom(''), 'managed');
    assert.equal(channelFrom('nonsense'), 'managed');
  });
});

describe('installChannel', () => {
  test('is managed in an unbaked (dev/test/npm-bundle) build', () => {
    assert.equal(installChannel(), 'managed');
  });
});
