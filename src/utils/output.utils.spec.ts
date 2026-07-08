// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { planLine, runStep } from './output.utils.js';

/** Swap a writable stream's `write` for a buffer; runtime-agnostic (no bun/jest spy API). */
function capture(stream: NodeJS.WriteStream): { output: () => string; restore: () => void } {
  const original = stream.write.bind(stream);
  let buffer = '';
  stream.write = ((chunk: unknown) => {
    buffer += String(chunk);
    return true;
  }) as typeof stream.write;
  return {
    output: () => buffer,
    restore: () => {
      stream.write = original;
    },
  };
}

describe('planLine', () => {
  let out: ReturnType<typeof capture>;
  afterEach(() => out?.restore());

  test('writes the text with an arrow prefix and newline', () => {
    out = capture(process.stdout);
    planLine('do a thing');
    assert.ok(out.output().includes('→ do a thing'));
    assert.ok(out.output().endsWith('\n'));
  });
});

describe('runStep', () => {
  let out: ReturnType<typeof capture>;
  let err: ReturnType<typeof capture>;

  afterEach(() => {
    out?.restore();
    err?.restore();
  });

  test('runs the step and collapses to a success line', async () => {
    out = capture(process.stdout);
    let ran = false;
    await runStep('install deps', async () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.ok(out.output().includes('✓ install deps'));
  });

  test('prints a failure line, surfaces the error, and rethrows', async () => {
    out = capture(process.stdout);
    err = capture(process.stderr);
    await assert.rejects(
      runStep('build', async () => {
        throw new Error('kaboom');
      }),
      /kaboom/
    );
    assert.ok(out.output().includes('✗ build'));
    assert.ok(err.output().includes('kaboom'));
  });

  test('stringifies a non-Error rejection', async () => {
    out = capture(process.stdout);
    err = capture(process.stderr);
    await runStep('weird', async () => {
      throw 'plain string';
    }).catch(() => undefined);
    assert.ok(err.output().includes('plain string'));
  });
});
