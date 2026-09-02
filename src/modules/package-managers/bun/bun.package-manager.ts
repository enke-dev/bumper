import { PackageManager } from '../../../context/context.types.js';
import { cleanInstall, selfUpdate } from '../../../utils/deps.utils.js';
import { upgradeAllWorkspaces } from '../../../utils/upgrade.utils.js';
import type { Module } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';

export const bunPackageManager: Module = {
  kind: ModuleKind.PackageManager,
  id: 'bun',
  title: 'Update dependencies (bun)',
  async isUsed(ctx) {
    return ctx.packageManager === PackageManager.Bun;
  },
  async update(ctx) {
    await selfUpdate(ctx, ['bun', 'upgrade']);
    // Bumps deps + the `bun@x` packageManager field across the workspace; the field takes the
    // release the bun runtime module resolved, so it and `.bun-version` never disagree.
    await upgradeAllWorkspaces(ctx);
    await cleanInstall(ctx, ['bun', 'install']);
  },
};
