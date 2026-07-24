// Throwaway tmp-dir harness shared by the specs that back their fs against a real directory. Lives
// under src/testing/ (not a `*.spec.ts`, so the runners skip it; unreachable from src/cli.ts, so
// the bundler never ships it). Centralizes the `bumper-<label>-` naming convention.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a throwaway tmp dir under the OS tmpdir, namespaced `bumper-<label>-`. */
export function makeTempDir(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `bumper-${label}-`));
}

/** Run `fn` against a fresh tmp dir (see {@link makeTempDir}), removing it afterwards. */
export async function withTempDir<T>(label: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir(label);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
