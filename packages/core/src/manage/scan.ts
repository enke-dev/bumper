import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { PackageManager } from '../context/context.types.js';
import { detectPackageManager } from '../context/detectors/package-manager.detector.js';
import { detectWorkspaces } from '../context/detectors/workspace.detector.js';
import { exec } from '../utils/exec.utils.js';
import { allDependencies, pathExists, readPackageJson } from '../utils/fs.utils.js';
import type { PackageJson } from '../utils/package.types.js';
import type { PublishedPackage, RepoInfo, WorkspaceScan } from './workspace.types.js';

/** How deep below the root a repo may sit (`~/Projects/<owner>/<repo>` is depth 2). */
const MAX_DEPTH = 4;

/** Directories never descended into while looking for repos. */
const SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'vendor']);

/**
 * Git repositories under `root`: a directory is a repo when it contains `.git` (dir or file, so
 * worktrees and submodules count). The walk stops at a repo and skips hidden dirs. Order is
 * stable (sorted by path) so ids and stages don't shuffle between scans.
 */
export async function findRepos(
  root: string,
  depth = MAX_DEPTH,
  seen = new Set<string>()
): Promise<string[]> {
  // symlinked dirs are followed; the real path dedupes a repo reachable twice and breaks loops
  const real = await realpath(root).catch(() => null);
  if (real === null || seen.has(real)) {
    return [];
  }
  seen.add(real);
  if (await pathExists(join(root, '.git'))) {
    return [root];
  }
  if (depth === 0) {
    return [];
  }
  const names = (await readdir(root).catch(() => [])).filter(
    name => !name.startsWith('.') && !SKIP.has(name)
  );
  const dirs = (
    await Promise.all(
      names.map(async name => {
        const path = join(root, name);
        const stats = await stat(path).catch(() => null);
        return stats?.isDirectory() ? path : null;
      })
    )
  )
    .filter((path): path is string => path !== null)
    .sort();
  const nested = await Promise.all(dirs.map(dir => findRepos(dir, depth - 1, seen)));
  return nested.flat();
}

/** `owner/name` of a GitHub repository reference — a URL in any spelling, the `github:owner/name`
 * shorthand or a bare `owner/name` — lower-cased, or null for anything else. */
export function githubSlug(url: string | undefined): string | null {
  const match =
    url?.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i) ??
    url?.match(/^github:([^/#]+)\/([^/#]+)$/i) ??
    url?.match(/^([\w.-]+)\/([\w.-]+)$/);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/**
 * A fork: a manifest says the project lives at one GitHub repo, `origin` points at another. The
 * root manifest counts first, then the workspace members (a forked monorepo often declares
 * `repository` only there). Decided locally, no API call; false whenever either side is unknown
 * or not on GitHub.
 */
export async function isFork(
  dir: string,
  manifests: readonly PackageJson[],
  run: typeof exec = exec
): Promise<boolean> {
  const declared =
    manifests
      .map(pkg =>
        githubSlug(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url)
      )
      .find((slug): slug is string => slug !== null) ?? null;
  if (declared === null) {
    return false;
  }
  const { exitCode, stdout } = await run(['git', 'remote', 'get-url', 'origin'], { cwd: dir });
  const origin = exitCode === 0 ? githubSlug(stdout.trim()) : null;
  return origin !== null && origin !== declared;
}

function publishedOf(manifests: PackageJson[]): PublishedPackage[] {
  return manifests
    .filter(pkg => pkg.name !== undefined && pkg.private !== true)
    .map(pkg => {
      const registry = pkg.publishConfig?.registry;
      return registry ? { name: pkg.name as string, registry } : { name: pkg.name as string };
    });
}

/** `yarn` repos are recognised but not handled yet (arrives via core later). */
async function unsupportedReason(dir: string, root: PackageJson): Promise<string | null> {
  if (root.packageManager?.startsWith('yarn') || (await pathExists(join(dir, 'yarn.lock')))) {
    return 'yarn is not supported yet';
  }
  return null;
}

/** Current branch, or null when detached / not a work tree. */
export async function currentBranch(dir: string, run: typeof exec = exec): Promise<string | null> {
  const { exitCode, stdout } = await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: dir,
  });
  const branch = stdout.trim();
  return exitCode === 0 && branch !== '' && branch !== 'HEAD' ? branch : null;
}

/** Local branch names (`git branch --format`), empty when git can't answer. */
export async function localBranches(dir: string, run: typeof exec = exec): Promise<string[]> {
  const { exitCode, stdout } = await run(['git', 'branch', '--format=%(refname:short)'], {
    cwd: dir,
  });
  return exitCode === 0
    ? stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
    : [];
}

/** Describe one repo: manifests, package manager, published names, dependency names. */
export async function inspectRepo(
  root: string,
  dir: string,
  run: typeof exec = exec
): Promise<RepoInfo> {
  const id = relative(root, dir).split(sep).join('/') || '.';
  const [branch, branches] = await Promise.all([currentBranch(dir, run), localBranches(dir, run)]);
  const base = { id, path: dir, branch, branches, fork: false };
  const pkg = await readPackageJson(dir);
  if (pkg === null) {
    return {
      ...base,
      private: true,
      packageManager: null,
      unsupported: 'no package.json',
      published: [],
      dependencies: [],
    };
  }
  const unsupported = await unsupportedReason(dir, pkg);
  const packageManager = await detectPackageManager(dir);
  const { workspaces } = await detectWorkspaces(dir, packageManager, run);
  const manifests = (await Promise.all(workspaces.map(member => readPackageJson(member)))).filter(
    (manifest): manifest is PackageJson => manifest !== null
  );
  const fork = await isFork(dir, manifests, run);
  const info: RepoInfo = {
    ...base,
    ...(pkg.name !== undefined ? { name: pkg.name } : {}),
    private: pkg.private === true,
    fork,
    packageManager: unsupported === null ? packageManager : null,
    published: publishedOf(manifests),
    dependencies: [
      ...new Set(manifests.flatMap(manifest => Object.keys(allDependencies(manifest)))),
    ],
  };
  return unsupported === null ? info : { ...info, unsupported };
}

/** Scan `root` for repos and describe each. `run` is injected in tests. */
export async function scanWorkspace(root: string, run: typeof exec = exec): Promise<WorkspaceScan> {
  const dirs = await findRepos(root);
  const repos = await Promise.all(dirs.map(dir => inspectRepo(root, dir, run)));
  return { root, repos };
}

export { PackageManager };
