// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isHeldLine, replaceUnheldLines } from './skip-comment.utils.js';

describe('isHeldLine', () => {
  test('holds the line right below a skip comment, with or without a reason, any case', () => {
    const lines = ['# bumper: skip', 'a', '  #Bumper: Skip - why', 'b', 'c'];
    assert.deepEqual(
      lines.map((_, index) => isHeldLine(lines, index)),
      [false, true, false, true, false]
    );
  });

  test('a blank line or another comment in between breaks the hold', () => {
    const lines = ['# bumper: skip', '', 'a', '# bumper: skip', '# why', 'b'];
    assert.equal(isHeldLine(lines, 2), false);
    assert.equal(isHeldLine(lines, 5), false);
  });

  test('ignores a comment that merely mentions skipping', () => {
    assert.equal(isHeldLine(['# bumper: skipped by hand', 'a'], 1), false);
  });
});

describe('replaceUnheldLines', () => {
  test('rewrites unheld lines only, keeping CRLF endings', () => {
    const text = 'FROM node:20\r\n# bumper: skip\r\nFROM node:20\r\n';
    const out = replaceUnheldLines(text, line => line.replace('node:20', 'node:24'));
    assert.equal(out, 'FROM node:24\r\n# bumper: skip\r\nFROM node:20\r\n');
  });
});
