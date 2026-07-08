// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { exec, execOk, toolExists } from './exec.utils.js';

describe('exec', () => {
  test('captures stdout and a zero exit code on success', async () => {
    const result = await exec(['node', '-e', "process.stdout.write('hello')"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'hello');
    assert.equal(result.stderr, '');
  });

  test('captures stderr and a non-zero exit code on failure', async () => {
    const result = await exec(['node', '-e', "process.stderr.write('boom'); process.exit(3)"]);
    assert.equal(result.exitCode, 3);
    assert.ok(result.stderr.includes('boom'));
  });

  test('passes env through to the child', async () => {
    const result = await exec(['node', '-e', 'process.stdout.write(process.env.BUMPER_TEST)'], {
      env: { BUMPER_TEST: 'yes' },
    });
    assert.equal(result.stdout, 'yes');
  });

  test('surfaces a missing binary as a failed exit, not a throw', async () => {
    const result = await exec(['this-binary-does-not-exist-xyz']);
    assert.equal(result.exitCode, 1);
    // spawn's error text differs across runtimes (Node: ENOENT, Bun: "not found in $PATH")
    assert.match(result.stderr, /ENOENT|not found/i);
  });

  test('throws on an empty command', async () => {
    await assert.rejects(exec([]), /exec called with an empty command/);
  });
});

describe('execOk', () => {
  test('resolves with the result on a zero exit', async () => {
    const result = await execOk(['node', '-e', "process.stdout.write('ok')"]);
    assert.equal(result.stdout, 'ok');
  });

  test('throws a descriptive error on a non-zero exit', async () => {
    await assert.rejects(
      execOk(['node', '-e', "process.stderr.write('nope'); process.exit(2)"]),
      /failed \(exit 2\)/
    );
  });
});

describe('toolExists', () => {
  test('finds a binary present on PATH', () => {
    // `node` is running this test, so it is resolvable on PATH
    assert.equal(toolExists('node'), true);
  });

  test('returns false for a binary not on PATH', () => {
    assert.equal(toolExists('this-binary-does-not-exist-xyz'), false);
  });
});
