import { anyExists, readPackageJson } from '../../utils/fs.utils.js';
import { Runtime } from '../context.types.js';

/** Detect the JS runtime a repo targets (bun wins over node when signalled). */
export async function detectRuntime(cwd: string): Promise<Runtime> {
  const pkg = await readPackageJson(cwd);
  if (pkg?.packageManager?.startsWith('bun')) {
    return Runtime.Bun;
  }
  if (await anyExists(cwd, ['bun.lock', 'bun.lockb'])) {
    return Runtime.Bun;
  }
  return Runtime.Node;
}
