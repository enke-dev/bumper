import { PackageManager } from '../../../context/context.types.js';
import { cleanInstall } from '../../../utils/deps.utils.js';
import { upgradeAllWorkspaces } from '../../../utils/upgrade.utils.js';
import type { Module } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';

export const npmPackageManager: Module = {
  kind: ModuleKind.PackageManager,
  id: 'npm',
  title: 'Update dependencies (npm)',
  async isUsed(ctx) {
    return ctx.packageManager === PackageManager.Npm;
  },
  async update(ctx) {
    await upgradeAllWorkspaces(ctx);
    await cleanInstall(ctx, ['npm', 'install']);
  },
};
