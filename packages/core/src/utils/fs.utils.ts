import { access, glob, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative as relativePath, resolve, sep } from 'node:path';

import type { PackageJson } from './package.types.js';

/** Whether a path exists (file or dir). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether any of the given names exists directly under `dir`. */
export async function anyExists(dir: string, names: string[]): Promise<boolean> {
  const present = await Promise.all(names.map(name => pathExists(join(dir, name))));
  return present.some(Boolean);
}

/**
 * Expand `pattern` under `cwd`, returning absolute paths to regular files only.
 * Uses the node `fs.glob` API (implemented by both Node ≥22 and Bun), so results
 * are cwd-relative — we resolve to absolute and `stat`-filter out directories
 * (Bun has no `withFileTypes` option, so the filter is done here, not in glob).
 */
export async function globFiles(cwd: string, pattern: string): Promise<string[]> {
  const relative = await Array.fromAsync(glob(pattern, { cwd }));
  const absolute = relative.map(entry => join(cwd, entry));
  const files = await Promise.all(
    absolute.map(async path => ((await stat(path)).isFile() ? path : null))
  );
  return files.filter((path): path is string => path !== null);
}

/**
 * Whether `path` (abs or repo-relative) falls under any repo-relative `exclude`
 * entry — an exact match or a descendant. Shared by the workspace filter and by
 * every file-discovering feature so `exclude` means the same thing everywhere.
 */
export function isExcluded(cwd: string, path: string, exclude: string[]): boolean {
  const rel = relativePath(cwd, resolve(cwd, path));
  return exclude.some(entry => rel === entry || rel.startsWith(`${entry}/`));
}

/**
 * Discover files under `cwd` matching `pattern`, honoring the repo's `exclude`
 * list and always skipping `node_modules`. Every file-based feature should route
 * its discovery through here so `exclude` is respected uniformly, not per-module.
 */
export async function collectFiles(
  cwd: string,
  pattern: string,
  exclude: string[] = []
): Promise<string[]> {
  const matches = await globFiles(cwd, pattern);
  return matches.filter(
    match => !match.split(sep).includes('node_modules') && !isExcluded(cwd, match, exclude)
  );
}

/** Read + parse a repo's `package.json`, or `null` if absent/invalid. */
export async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/** First indent unit of an already-formatted file: the leading whitespace of a nested key. */
const INDENT_UNIT = /^([ \t]+)(?=")/m;

/**
 * The formatting an existing file already uses. Rewriting a file wholesale must not restyle it —
 * a repo indenting `package.json` with tabs got two spaces back, so every line came out changed
 * and its own `prettier --check` failed on the update PR.
 *
 * Read off the file's own bytes rather than resolved from `.editorconfig`/`.prettierrc`/etc: the
 * file already reflects whatever the repo enforces (including no config at all), so preserving it
 * is both simpler and correct for tooling we don't know about. Defaults (two spaces, LF, trailing
 * newline) apply only when the file is new or has nothing to read a style from.
 */
export function detectFormat(content: string): { indent: string; eol: string; final: string } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  return {
    indent: INDENT_UNIT.exec(content)?.[1] ?? '  ',
    eol,
    final: content === '' || content.endsWith('\n') ? eol : '',
  };
}

/** Existing contents of `path`, or `''` when it doesn't exist / can't be read. */
async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/** Write `package.json`, keeping the indent, line endings and trailing newline it already had. */
export async function writePackageJson(dir: string, pkg: PackageJson): Promise<void> {
  const path = join(dir, 'package.json');
  const { indent, eol, final } = detectFormat(await readOrEmpty(path));
  const json = JSON.stringify(pkg, null, indent);
  await writeFile(path, `${eol === '\n' ? json : json.replaceAll('\n', eol)}${final}`);
}

/**
 * Write a single-line file (`.node-version`, `.bun-version`, `.nvmrc`), keeping the line ending
 * and trailing-newline style it already had. New files get the LF + trailing newline default.
 */
export async function writeLine(path: string, line: string): Promise<void> {
  const { final } = detectFormat(await readOrEmpty(path));
  await writeFile(path, `${line}${final}`);
}

/** Combined dependency spec map across all dependency buckets. */
export function allDependencies(pkg: PackageJson): Record<string, string> {
  return {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  };
}
