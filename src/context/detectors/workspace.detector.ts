import { readFile } from 'node:fs/promises';
import { dirname, join, matchesGlob, relative } from 'node:path';

import { globFiles, pathExists, readPackageJson } from '../../utils/fs.utils.js';
import { PackageManager } from '../context.types.js';

export interface WorkspaceInfo {
  isMonorepo: boolean;
  /** Absolute package dirs, repo root first. */
  workspaces: string[];
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

/** Resolve workspace member dirs by expanding globs, honoring `!` negations. */
export async function detectWorkspaces(cwd: string, pm: PackageManager): Promise<WorkspaceInfo> {
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
  const members = [...found].sort();
  return { isMonorepo: members.length > 0, workspaces: [cwd, ...members] };
}
