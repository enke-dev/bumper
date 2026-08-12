import { join } from 'node:path';

import type { PackageManager } from '../context/context.types.js';
import { exec, toolExists } from './exec.utils.js';
import { pathExists, readPackageJson } from './fs.utils.js';
import { planLine } from './output.utils.js';

const RUN_SCRIPT: Record<PackageManager, string[]> = {
  npm: ['npm', 'run'],
  pnpm: ['pnpm', 'run'],
  bun: ['bun', 'run'],
};

const LOCAL_BINS = ['node_modules/.bin/eslint', 'node_modules/.bin/prettier'];

/** Resolve the format command for a repo: `format` script > eslint --fix > prettier --write. */
export async function resolveFormatCmd(
  cwd: string,
  packageManager: PackageManager
): Promise<string[] | null> {
  const pkg = await readPackageJson(cwd);
  if (pkg?.scripts?.['format']) {
    return [...RUN_SCRIPT[packageManager], 'format'];
  }
  const localEslint = join(cwd, 'node_modules/.bin/eslint');
  if (await pathExists(localEslint)) {
    return [localEslint, '--fix', '.'];
  }
  if (toolExists('eslint')) {
    return ['eslint', '--fix', '.'];
  }
  const localPrettier = join(cwd, 'node_modules/.bin/prettier');
  if (await pathExists(localPrettier)) {
    return [localPrettier, '--write', '.'];
  }
  if (toolExists('prettier')) {
    return ['prettier', '--write', '.'];
  }
  return null;
}

/** Run the auto-detected format command for a repo. No-op when none is found. */
export async function runFormat(
  cwd: string,
  packageManager: PackageManager,
  dryRun: boolean,
  run: typeof exec = exec
): Promise<void> {
  const cmd = await resolveFormatCmd(cwd, packageManager);
  if (cmd === null) {
    return;
  }
  if (dryRun) {
    planLine(cmd.join(' '));
    return;
  }
  await run(cmd, { cwd });
}

/** Check whether local eslint/prettier binaries exist (used in tests). */
export async function hasLocalBin(cwd: string): Promise<boolean> {
  const present = await Promise.all(LOCAL_BINS.map(bin => pathExists(join(cwd, bin))));
  return present.some(Boolean);
}
