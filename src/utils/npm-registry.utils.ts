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
