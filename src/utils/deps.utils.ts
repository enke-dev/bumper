import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModuleContext } from '../context/context.types.js';
import { PackageManager } from '../context/context.types.js';
import { execOk, toolExists } from './exec.utils.js';
import { planLine } from './output.utils.js';

/** Lockfiles owned by each package manager, removed on a clean install so the reinstall
 * re-resolves against the freshly rewritten `package.json`. */
const LOCKFILES: Record<PackageManager, readonly string[]> = {
  [PackageManager.Npm]: ['package-lock.json', 'npm-shrinkwrap.json'],
  [PackageManager.Pnpm]: ['pnpm-lock.yaml'],
  [PackageManager.Bun]: ['bun.lock', 'bun.lockb'],
};

/**
 * Remove the root `node_modules` *and the package manager's lockfile*, then reinstall. Dropping
 * the lockfile is essential: after bumping a dependency to a version with new/changed peers (e.g.
 * `@enke.dev/lint` adding a `typescript@6.0.3` peer), a stale lockfile still pins the old tree, so
 * `npm install` reconciles against it and dies with a phantom `ERESOLVE` — even though the
 * rewritten `package.json` is perfectly satisfiable. A fresh resolve matches the new specs.
 */
export async function cleanInstall(ctx: ModuleContext, installCmd: string[]): Promise<void> {
  const lockfiles = LOCKFILES[ctx.packageManager] ?? [];
  if (ctx.dryRun) {
    planLine(['rm -rf', 'node_modules', ...lockfiles].join(' '));
    planLine(installCmd.join(' '));
    return;
  }
  await rm(join(ctx.cwd, 'node_modules'), { recursive: true, force: true });
  await Promise.all(lockfiles.map(file => rm(join(ctx.cwd, file), { force: true })));
  await execOk(installCmd, { cwd: ctx.cwd });
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
