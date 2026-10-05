// Runtime-agnostic test (node:test + node:assert): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseTag, pickNewestTag } from './docker-tags.utils.js';

describe('parseTag', () => {
  test('splits numeric core + variant, counts precision', () => {
    assert.deepEqual(parseTag('16'), { core: '16', segments: 1, variant: '' });
    assert.deepEqual(parseTag('16.3'), { core: '16.3', segments: 2, variant: '' });
    assert.deepEqual(parseTag('16.3.1'), { core: '16.3.1', segments: 3, variant: '' });
    assert.deepEqual(parseTag('16-alpine'), { core: '16', segments: 1, variant: 'alpine' });
    assert.deepEqual(parseTag('3.12-slim-bookworm'), {
      core: '3.12',
      segments: 2,
      variant: 'slim-bookworm',
    });
  });

  test('non-numeric tags yield null (left untouched)', () => {
    ['latest', 'stable', 'bookworm', 'alpine', 'lts', ''].forEach(tag =>
      assert.equal(parseTag(tag), null, tag)
    );
  });
});

describe('pickNewestTag', () => {
  const tags = [
    '16',
    '17',
    '18',
    '18.3',
    '18.3-alpine',
    '17-alpine',
    '16-alpine',
    'latest',
    'bookworm',
  ];

  test('bumps within the same precision + variant, crossing majors', () => {
    assert.equal(pickNewestTag('16', tags), '18'); // bare major → newest bare major
    // same variant (alpine) + same precision (bare major): 16-alpine/17-alpine race, 18.3-alpine
    // is 2-segment so it's excluded → 17-alpine wins.
    assert.equal(pickNewestTag('16-alpine', tags), '17-alpine');
  });

  test('precision is preserved: a bare major never jumps to a X.Y tag', () => {
    assert.equal(pickNewestTag('16', ['16', '18.3']), null); // no bare-major newer than 16
  });

  test('variant is preserved: plain never matches a variant tag', () => {
    assert.equal(pickNewestTag('16', ['16', '18-alpine']), null);
  });

  test('returns null when already newest, or current tag is non-numeric', () => {
    assert.equal(pickNewestTag('18', tags), null);
    assert.equal(pickNewestTag('latest', tags), null);
  });
});
