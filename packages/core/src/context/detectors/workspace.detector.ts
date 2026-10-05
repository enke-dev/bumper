import { readFile } from 'node:fs/promises';
import { dirname, join, matchesGlob, relative } from 'node:path';

import { exec } from '../../utils/exec.utils.js';
import { globFiles, pathExists, readPackageJson } from '../../utils/fs.utils.js';
import { PackageManager } from '../context.types.js';

export interface WorkspaceInfo {
  isMonorepo: boolean;
  /** Absolute package dirs, repo root first. */
  workspaces: string[];
}

/**
 * Drop member dirs whose `package.json` is git-ignored. A git-ignored workspace package is
 * externally managed — generated or vendored (e.g. a wrapper around an upstream lib) — and its
 * manifest is never committed. Bumping its specs would rewrite a file git doesn't track while the
 * bumped versions leak into the *tracked* lockfile, so CI regenerates the manifest at the old
 * versions and `--frozen-lockfile` fails with a manifest/lockfile mismatch. Best-effort: if git is
 * absent or this isn't a repo, every member is kept (the check simply doesn't apply). `run` is
 * injected in tests. */
async function withoutIgnored(
  cwd: string,
  dirs: string[],
  run: typeof exec = exec
): Promise<string[]> {
  if (dirs.length === 0) {
    return dirs;
  }
  const manifestOf = (dir: string): string => join(dir, 'package.json');
  const { exitCode, stdout } = await run(['git', 'check-ignore', ...dirs.map(manifestOf)], { cwd });
  // 0 = some paths ignored (listed on stdout); 1 = none ignored. Anything else (128 = not a git
  // repo, ENOENT = git missing) means the check couldn't run → keep every member.
  if (exitCode !== 0 && exitCode !== 1) {
    return dirs;
  }
  const ignored = new Set(
    stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  );
  return dirs.filter(dir => !ignored.has(manifestOf(dir)));
}

/** Extract the `packages:` list from a `pnpm-workspace.yaml` body. */
function parsePnpmPackages(yaml: string): string[] {
  // reduce carrying the `inBlock` flag as accumulator state, since the parse is line-order
  // dependent (the `packages:` key opens the block, the next top-level key closes it)
  return yaml.split('\n').reduce<{ inBlock: boolean; globs: string[] }>(
    (state, raw) => {
      const line = raw.replace(/\s+$/, '');
      if (/^packages:\s*$/.test(line)) {
        return { ...state, inBlock: true };
      }
      if (!state.inBlock) {
        return state;
      }
      const item = line.match(/^\s*-\s+(.+)$/);
      if (item?.[1]) {
        state.globs.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
        return state;
      }
      if (line.trim() === '') {
        return state;
      }
      // a next top-level key ends the block
      return /^\S/.test(line) ? { ...state, inBlock: false } : state;
    },
    { inBlock: false, globs: [] }
  ).globs;
}

/** Read workspace globs from the pm-appropriate source. */
async function readWorkspaceGlobs(cwd: string, pm: PackageManager): Promise<string[]> {
  if (pm === PackageManager.Pnpm) {
    const file = join(cwd, 'pnpm-workspace.yaml');
    return (await pathExists(file)) ? parsePnpmPackages(await readFile(file, 'utf8')) : [];
  }
  const pkg = await readPackageJson(cwd);
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) {
    return ws;
  }
  if (ws && Array.isArray(ws.packages)) {
    return ws.packages;
  }
  return [];
}

/** Resolve workspace member dirs by expanding globs, honoring `!` negations. `run` is injected
 * in tests (defaults to the real `exec`, used to consult `git check-ignore`). */
export async function detectWorkspaces(
  cwd: string,
  pm: PackageManager,
  run: typeof exec = exec
): Promise<WorkspaceInfo> {
  const globs = await readWorkspaceGlobs(cwd, pm);
  const positives = globs.filter(g => !g.startsWith('!'));
  const negatives = globs.filter(g => g.startsWith('!')).map(g => g.slice(1));
  if (positives.length === 0) {
    return { isMonorepo: false, workspaces: [cwd] };
  }

  const matches = await Promise.all(
    positives.map(pattern => globFiles(cwd, `${pattern}/package.json`))
  );
  const found = new Set(
    matches
      .flat()
      .map(match => dirname(match))
      .filter(dir => !negatives.some(neg => matchesGlob(relative(cwd, dir), neg)))
  );
  const members = await withoutIgnored(cwd, [...found].sort(), run);
  return { isMonorepo: members.length > 0, workspaces: [cwd, ...members] };
}
