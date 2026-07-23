import { compareReversed, getPrerelease, isValid, satisfies } from 'verkit';

import { PackageManager } from '../context/context.types.js';
import { exec, execOk } from './exec.utils.js';

/**
 * Fetch + parse JSON over curl (used for the auth-less Node dist index). `run` defaults to the
 * real `execOk` and is only overridden by tests, so the network call can be driven offline.
 */
export async function curlJson<T>(url: string, run: typeof execOk = execOk): Promise<T> {
  const { stdout } = await run(['curl', '-sSL', '--fail', '--connect-timeout', '20', url]);
  return JSON.parse(stdout) as T;
}

/**
 * The `view`-capable tool for a package manager. pnpm has its own; npm covers
 * npm and bun repos. Both read `.npmrc`, so private registries + auth resolve
 * correctly without us reimplementing them.
 */
export function viewTool(pm: PackageManager): string {
  return pm === PackageManager.Pnpm ? 'pnpm' : 'npm';
}

/**
 * Latest published version of a package via `<tool> view <pkg> version`, run in
 * the repo so its `.npmrc` (scoped registries, auth) applies. Null if
 * unresolvable (network, private without access, 404).
 */
export async function latestVersion(
  pkg: string,
  tool: string,
  cwd: string,
  run: typeof exec = exec
): Promise<string | null> {
  try {
    const { exitCode, stdout } = await run([tool, 'view', pkg, 'version'], { cwd });
    if (exitCode !== 0) {
      return null;
    }
    const version = stdout.trim().split('\n').pop()?.trim();
    return version && /^\d/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * The `peerDependencies` an *exact* package version declares, via `<tool> view '<pkg>@<v>'
 * peerDependencies --json`. Read from the registry (not `node_modules`) so it reflects the
 * version being bumped *to*, not the stale one currently installed. Empty object when the
 * version declares no peers, or on any error/unparseable output. Passing an exact version
 * (not a range) keeps the output a single object rather than a per-version array.
 */
export async function peerDependenciesOf(
  pkg: string,
  version: string,
  tool: string,
  cwd: string,
  run: typeof exec = exec
): Promise<Record<string, string>> {
  try {
    const { exitCode, stdout } = await run(
      [tool, 'view', `${pkg}@${version}`, 'peerDependencies', '--json'],
      { cwd }
    );
    const trimmed = stdout.trim();
    if (exitCode !== 0 || !trimmed) {
      return {};
    }
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Highest published, non-prerelease version of a package satisfying `range`, via
 * `<tool> view '<pkg>@<range>' version`. The tool lists matches ascending — one match
 * prints a bare version, several print `<pkg>@<v> '<v>'` lines — so the last wins.
 * Null if nothing matches (or on error).
 */
export async function latestVersionInRange(
  pkg: string,
  range: string,
  tool: string,
  cwd: string,
  run: typeof exec = exec
): Promise<string | null> {
  try {
    const { exitCode, stdout } = await run([tool, 'view', `${pkg}@${range}`, 'version'], { cwd });
    if (exitCode !== 0) {
      return null;
    }
    const last = stdout.trim().split('\n').pop()?.trim();
    const version = last?.replace(/.*@/, '').replace(/['" ].*/, '');
    return version && /^\d/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Highest published, non-prerelease version of a package satisfying *every* range in `ranges`
 * (semver AND) — the correct intersection of multiple peer constraints. It fetches the full
 * version list (`<tool> view <pkg> versions --json`) and filters with verkit's `satisfies` per
 * range, because ranges cannot be intersected by string-joining: a peer like `^17 || ^18 || ^19`
 * space-joined with another OR-range produces a *different* range depending on operand order
 * (`A B || C` parses as `A AND B, OR C`), silently allowing versions every peer forbids. Checking
 * each candidate against each range independently is order-independent and honors `||`. Null when
 * nothing satisfies all ranges, `ranges` is empty, or on error.
 */
export async function maxSatisfyingRanges(
  pkg: string,
  ranges: readonly string[],
  tool: string,
  cwd: string,
  run: typeof exec = exec
): Promise<string | null> {
  if (ranges.length === 0) {
    return null;
  }
  try {
    const { exitCode, stdout } = await run([tool, 'view', pkg, 'versions', '--json'], { cwd });
    if (exitCode !== 0) {
      return null;
    }
    const trimmed = stdout.trim();
    if (!trimmed) {
      return null;
    }
    const parsed: unknown = JSON.parse(trimmed);
    // A package with a single published version prints a bare string, not an array.
    const versions = Array.isArray(parsed)
      ? (parsed as string[])
      : typeof parsed === 'string'
        ? [parsed]
        : [];
    const match = versions
      .filter(v => isValid(v) && getPrerelease(v)?.length === 0)
      .filter(v => ranges.every(range => satisfies(v, range)))
      .sort(compareReversed)[0];
    return match ?? null;
  } catch {
    return null;
  }
}
