// Copies an `examples/` fixture into a throwaway tmp dir for the duration of a test body. Lives
// under src/testing/ (not a `*.spec.ts`, so the runners skip it; unreachable from src/cli.ts, so
// the bundler never ships it).
import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withTempDir } from './with-temp-dir.harness.js';

/** Absolute path to the repo's `examples/` fixtures, resolved from this file's location. */
export const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples');

/** Copy an example fixture into a throwaway tmp dir, run `fn`, then clean up. */
export function withFixture(name: string, fn: (dir: string) => Promise<void>): Promise<void> {
  return withTempDir(name, async dir => {
    await cp(join(EXAMPLES, name), dir, { recursive: true });
    await fn(dir);
  });
}
