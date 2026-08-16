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

/** Return the path of a local binary, checking both the plain name and the Windows `.cmd` shim. */
async function resolveLocalBin(cwd: string, name: string): Promise<string | null> {
  const plain = join(cwd, 'node_modules/.bin', name);
  if (await pathExists(plain)) {
    return plain;
  }
  const cmd = join(cwd, 'node_modules/.bin', `${name}.cmd`);
  if (await pathExists(cmd)) {
    return cmd;
  }
  return null;
}

/** Resolve the format command for a repo: `format` script > eslint --fix > prettier --write. */
export async function resolveFormatCmd(
  cwd: string,
  packageManager: PackageManager,
  checkTool: typeof toolExists = toolExists
): Promise<string[] | null> {
  const pkg = await readPackageJson(cwd);
  if (pkg?.scripts?.['format']) {
    return [...RUN_SCRIPT[packageManager], 'format'];
  }
  const localEslint = await resolveLocalBin(cwd, 'eslint');
  if (localEslint !== null) {
    return [localEslint, '--fix', '.'];
  }
  const localPrettier = await resolveLocalBin(cwd, 'prettier');
  if (localPrettier !== null) {
    return [localPrettier, '--write', '.'];
  }
  if (checkTool('eslint')) {
    return ['eslint', '--fix', '.'];
  }
  if (checkTool('prettier')) {
    return ['prettier', '--write', '.'];
  }
  return null;
}

/** Run the auto-detected format command for a repo. No-op when none is found. */
export async function runFormat(
  cwd: string,
  packageManager: PackageManager,
  dryRun: boolean,
  run: typeof exec = exec,
  checkTool: typeof toolExists = toolExists
): Promise<void> {
  const cmd = await resolveFormatCmd(cwd, packageManager, checkTool);
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
