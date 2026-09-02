import { join } from 'node:path';

import type { PackageManager } from '../context/context.types.js';
import { dirtyPaths, isGitRepo } from './commit.utils.js';
import { exec, toolExists } from './exec.utils.js';
import { pathExists, readPackageJson } from './fs.utils.js';
import { DIM, planLine, RESET } from './output.utils.js';

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

/**
 * Undo formatter edits to files the update itself never touched. `--format` exists to tidy
 * bumper's own rewrites (manifests, lockfiles), but every formatter we can resolve runs repo-wide
 * (`eslint --fix .`, `prettier --write .`, an arbitrary `format` script), so it also picks up
 * unrelated files — including ones bumper was told to leave alone: with `--skip github-actions`
 * (the default `GITHUB_TOKEN` can't push `.github/workflows/*` without the `workflows` scope) a
 * reformatted workflow file still lands in the commit and the push is rejected. Reverting
 * everything outside the pre-format dirty set keeps the formatter scoped to the update, whatever
 * modules were skipped or paths excluded — and keeps unrelated reformat noise out of the PR.
 * Tracked files are restored from HEAD; files the formatter created are removed.
 */
async function revertFormatterOnlyChanges(
  cwd: string,
  before: ReadonlySet<string>,
  run: typeof exec
): Promise<void> {
  const after = await dirtyPaths(cwd, run);
  const strays = after.filter(entry => !before.has(entry.path));
  if (strays.length === 0) {
    return;
  }
  const tracked = strays.filter(entry => !entry.untracked).map(entry => entry.path);
  const untracked = strays.filter(entry => entry.untracked).map(entry => entry.path);
  if (tracked.length > 0) {
    await run(['git', 'checkout', '--', ...tracked], { cwd });
  }
  if (untracked.length > 0) {
    await run(['git', 'clean', '-f', '--', ...untracked], { cwd });
  }
  process.stdout.write(
    `${DIM}reverted formatter changes to ${strays.length} file(s) the update didn't touch${RESET}\n`
  );
}

/**
 * Run the auto-detected format command for a repo, then discard its edits to files the update
 * didn't change (see {@link revertFormatterOnlyChanges}). No-op when no formatter is found; the
 * scoping is skipped outside a git repo, where there is no baseline to restore from.
 */
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
    planLine(`${cmd.join(' ')} (changes to files the update didn't touch are reverted)`);
    return;
  }
  const scoped = await isGitRepo(cwd, run);
  const before = new Set(scoped ? (await dirtyPaths(cwd, run)).map(entry => entry.path) : []);
  await run(cmd, { cwd });
  if (scoped) {
    await revertFormatterOnlyChanges(cwd, before, run);
  }
}

/** Check whether local eslint/prettier binaries exist (used in tests). */
export async function hasLocalBin(cwd: string): Promise<boolean> {
  const present = await Promise.all(LOCAL_BINS.map(bin => pathExists(join(cwd, bin))));
  return present.some(Boolean);
}
