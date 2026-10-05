import { PackageManager } from '../../../context/context.types.js';
import { recordYoungConsumptions } from '../../../utils/allow-young.utils.js';
import { approveScripts, cleanInstall, selfUpdate } from '../../../utils/deps.utils.js';
import { upgradeAllWorkspaces } from '../../../utils/upgrade.utils.js';
import type { Module } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';

export const pnpmPackageManager: Module = {
  kind: ModuleKind.PackageManager,
  id: 'pnpm',
  title: 'Update dependencies (pnpm)',
  async isUsed(ctx) {
    return ctx.packageManager === PackageManager.Pnpm;
  },
  async update(ctx) {
    await selfUpdate(ctx, ['pnpm', 'self-update']);
    await upgradeAllWorkspaces(ctx);
    // before the install: pnpm re-checks the cooldown against the lockfile on every install, so a
    // young version needs its pinned exclude rule committed alongside (see allow-young.utils.ts)
    await recordYoungConsumptions(ctx);
    await cleanInstall(ctx, ['pnpm', 'install']);
    await approveScripts(ctx, ['pnpm', 'approve-builds', '--all']);
  },
};
