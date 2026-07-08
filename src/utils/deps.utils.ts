import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModuleContext } from '../context/context.types.js';
import { execOk, toolExists } from './exec.utils.js';
import { planLine } from './output.utils.js';

/** Remove the root `node_modules` and reinstall with the given command. */
export async function cleanInstall(ctx: ModuleContext, installCmd: string[]): Promise<void> {
  if (ctx.dryRun) {
    planLine('rm -rf node_modules');
    planLine(installCmd.join(' '));
    return;
  }
  await rm(join(ctx.cwd, 'node_modules'), { recursive: true, force: true });
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
