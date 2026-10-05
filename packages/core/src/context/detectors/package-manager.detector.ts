import { join } from 'node:path';

import { pathExists, readPackageJson } from '../../utils/fs.utils.js';
import { PackageManager } from '../context.types.js';

/**
 * Detect the package manager. The `packageManager` field is authoritative;
 * lockfiles are the fallback. Defaults to npm when nothing is conclusive.
 */
export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  const pkg = await readPackageJson(cwd);
  const field = pkg?.packageManager ?? '';
  if (field.startsWith('pnpm')) {
    return PackageManager.Pnpm;
  }
  if (field.startsWith('bun')) {
    return PackageManager.Bun;
  }
  if (field.startsWith('npm')) {
    return PackageManager.Npm;
  }

  if (await pathExists(join(cwd, 'pnpm-lock.yaml'))) {
    return PackageManager.Pnpm;
  }
  if ((await pathExists(join(cwd, 'bun.lock'))) || (await pathExists(join(cwd, 'bun.lockb')))) {
    return PackageManager.Bun;
  }
  if (await pathExists(join(cwd, 'package-lock.json'))) {
    return PackageManager.Npm;
  }

  return PackageManager.Npm;
}
