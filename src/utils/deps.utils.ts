import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModuleContext } from '../context/context.types.js';
import { PackageManager } from '../context/context.types.js';
import { execOk, toolExists } from './exec.utils.js';
import { planLine, stepNote } from './output.utils.js';

/** Lockfiles owned by each package manager, removed on a clean install so the reinstall
 * re-resolves against the freshly rewritten `package.json`. */
const LOCKFILES: Record<PackageManager, readonly string[]> = {
  [PackageManager.Npm]: ['package-lock.json', 'npm-shrinkwrap.json'],
  [PackageManager.Pnpm]: ['pnpm-lock.yaml'],
  [PackageManager.Bun]: ['bun.lock', 'bun.lockb'],
};

/**
 * Resolution failures that mean "this version exists, the registry just isn't serving it yet".
 * A monorepo release (typescript-eslint, vitest, …) publishes its packages seconds apart, and
 * npmjs propagates them independently — so a bump can resolve the umbrella package to a version
 * whose sibling dependency is still a 404, and the install dies with a version that is genuinely
 * published. Matched on the manager's own error identifiers/wording (pnpm code, npm code, bun
 * message) rather than the package name, so an unrelated failure isn't retried.
 */
const PROPAGATION_LAG_MARKERS = [
  'ERR_PNPM_NO_MATCHING_VERSION', // pnpm
  'ETARGET', // npm
  'No version matching', // bun
];

/** One retry only, and short: propagation is seconds, and CI runner time is the budget. The
 * alternative — failing the bump and rerunning `bumper update` from scratch — costs minutes. */
const PROPAGATION_RETRY_DELAY_MS = 15_000;

/** Whether a failed install output carries a propagation-lag marker. Exported for tests. */
export function isPropagationLag(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return PROPAGATION_LAG_MARKERS.some(marker => message.includes(marker));
}

/**
 * Run the install, retrying **once** after a short wait if it failed only because a just-published
 * version hasn't propagated across the registry yet (see {@link PROPAGATION_LAG_MARKERS}). Every
 * other failure throws immediately, so a real unsatisfiable range still fails fast. `delayMs` is
 * only overridden by tests, so the retry path runs without the real wait.
 */
export async function installWithRetry(
  cmd: string[],
  cwd: string,
  delayMs: number = PROPAGATION_RETRY_DELAY_MS
): Promise<void> {
  try {
    await execOk(cmd, { cwd });
  } catch (error) {
    if (!isPropagationLag(error)) {
      throw error;
    }
    stepNote(
      `a bumped version is not served by the registry yet; retrying install in ${Math.round(delayMs / 1000)}s`
    );
    await new Promise(resolve => setTimeout(resolve, delayMs));
    await execOk(cmd, { cwd });
  }
}

/**
 * Remove the root `node_modules` *and the package manager's lockfile*, then reinstall. Dropping
 * the lockfile is essential: after bumping a dependency to a version with new/changed peers (e.g.
 * `@enke.dev/lint` adding a `typescript@6.0.3` peer), a stale lockfile still pins the old tree, so
 * `npm install` reconciles against it and dies with a phantom `ERESOLVE` — even though the
 * rewritten `package.json` is perfectly satisfiable. A fresh resolve matches the new specs.
 *
 * The install runs *twice*. A from-scratch `npm install` (no lockfile) is not idempotent: it
 * resolves optional/peer deps on the first pass and only dedupes them on a second, so the
 * first-pass lockfile still differs from what any later `npm install` produces. Committing that
 * first-pass lockfile means the next plain `npm i` a developer runs immediately rewrites it. A
 * second pass settles the tree, so the committed lockfile matches a subsequent install and
 * `bumper update` leaves no follow-up churn. pnpm/bun converge in one pass, but a second install
 * against a satisfied lockfile is a cheap no-op, so the loop is uniform across managers.
 *
 * The install runs with `--ignore-scripts` (supported by npm/pnpm/bun alike). Only the resolved
 * lockfile matters here, and lifecycle scripts (`prepare`/`postinstall`: codegen, workspace
 * builds) don't affect it — but they routinely fail in a bare CI checkout (missing tokens,
 * unbuilt `dist`, nested package-manager version churn), which would abort the bump for no reason.
 */
export async function cleanInstall(ctx: ModuleContext, installCmd: string[]): Promise<void> {
  const lockfiles = LOCKFILES[ctx.packageManager] ?? [];
  const cmd = [...installCmd, '--ignore-scripts'];
  if (ctx.dryRun) {
    planLine(['rm -rf', 'node_modules', ...lockfiles].join(' '));
    planLine(`${cmd.join(' ')} (run twice to settle the lockfile)`);
    return;
  }
  await rm(join(ctx.cwd, 'node_modules'), { recursive: true, force: true });
  await Promise.all(lockfiles.map(file => rm(join(ctx.cwd, file), { force: true })));
  await installWithRetry(cmd, ctx.cwd);
  await installWithRetry(cmd, ctx.cwd);
}

/**
 * Approve dependency install scripts so the repo carries an explicit allowlist instead of leaving
 * them pending. Modern package managers block (or, in npm's advisory phase, flag) lifecycle
 * scripts of freshly added deps until approved: `npm approve-scripts --all` writes `allowScripts`
 * to package.json, `pnpm approve-builds --all` writes `allowBuilds` to the pnpm workspace. bun has
 * no bulk-approve command (it uses a manual `trustedDependencies` array), so its module passes no
 * command and this is skipped.
 *
 * Best-effort and non-fatal: an older package-manager binary that predates the command (e.g. npm
 * < 11.16) simply reports an unknown command — ignored, like a corepack self-update that can't
 * run. Must run *after* install so the manager can see which installed deps carry scripts.
 */
export async function approveScripts(ctx: ModuleContext, cmd: string[]): Promise<void> {
  if (cmd.length === 0) {
    return;
  }
  if (ctx.dryRun) {
    planLine(cmd.join(' '));
    return;
  }
  const [bin] = cmd;
  if (!bin || !toolExists(bin)) {
    return;
  }
  try {
    await execOk(cmd, { cwd: ctx.cwd });
  } catch {
    // command absent on older package-manager versions (unknown command); ignore and continue.
  }
}

/** Best-effort self-update of a package manager (non-fatal on failure). */
export async function selfUpdate(ctx: ModuleContext, cmd: string[]): Promise<void> {
  if (ctx.dryRun) {
    planLine(cmd.join(' '));
    return;
  }
  const [bin] = cmd;
  if (!bin || !toolExists(bin)) {
    return;
  }
  try {
    await execOk(cmd, { cwd: ctx.cwd });
  } catch {
    // corepack-managed managers can't self-update; ignore and continue.
  }
}
