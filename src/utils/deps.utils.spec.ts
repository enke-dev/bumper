// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { ModuleContext } from '../context/context.types.js';
import { cleanInstall, selfUpdate } from './deps.utils.js';

function ctx(overrides: Partial<ModuleContext> = {}): ModuleContext {
  return { cwd: '/nonexistent-bumper-cwd', dryRun: true, ...overrides } as ModuleContext;
}

/** Swap `process.stdout.write` for a buffer; runtime-agnostic (no bun/jest spy API). */
function captureStdout(): { output: () => string; restore: () => void } {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  process.stdout.write = ((chunk: unknown) => {
    buffer += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    output: () => buffer,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

let out: ReturnType<typeof captureStdout>;
afterEach(() => out?.restore());

describe('cleanInstall', () => {
  test('dry-run plans the removal and install without touching the fs', async () => {
    out = captureStdout();
    await cleanInstall(ctx(), ['npm', 'install']);
    assert.ok(out.output().includes('rm -rf node_modules'));
    assert.ok(out.output().includes('npm install'));
  });
});

describe('selfUpdate', () => {
  test('dry-run plans the command', async () => {
    out = captureStdout();
    await selfUpdate(ctx(), ['pnpm', 'self-update']);
    assert.ok(out.output().includes('pnpm self-update'));
  });

  test('is a no-op for a missing binary (non-fatal)', async () => {
    out = captureStdout();
    // real (non-dry) path: unresolvable binary short-circuits before any exec
    assert.equal(
      await selfUpdate(ctx({ dryRun: false }), ['this-binary-does-not-exist-xyz', 'update']),
      undefined
    );
    assert.equal(out.output(), '');
  });

  test('is a no-op for an empty command', async () => {
    assert.equal(await selfUpdate(ctx({ dryRun: false }), []), undefined);
  });
});
