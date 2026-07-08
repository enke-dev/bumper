import { PackageManager } from '../../../context/context.types.js';
import { cleanInstall, selfUpdate } from '../../../utils/deps.utils.js';
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
    await cleanInstall(ctx, ['pnpm', 'install']);
  },
};
