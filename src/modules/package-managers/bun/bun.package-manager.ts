import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PackageManager } from '../../../context/context.types.js';
import { cleanInstall, selfUpdate } from '../../../utils/deps.utils.js';
import { readPackageJson } from '../../../utils/fs.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import { upgradeAllWorkspaces } from '../../../utils/upgrade.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';

/** Pin `.bun-version` to the bun version in the (ncu-bumped) packageManager field. */
async function pinBunVersion(ctx: ModuleContext): Promise<void> {
  const pkg = await readPackageJson(ctx.cwd);
  const version = pkg?.packageManager?.match(/^bun@(.+)$/)?.[1];
  if (!version) {
    return;
  }
  if (ctx.dryRun) {
    planLine(`write ${version} to .bun-version`);
    return;
  }
  await writeFile(join(ctx.cwd, '.bun-version'), `${version}\n`);
}

export const bunPackageManager: Module = {
  kind: ModuleKind.PackageManager,
  id: 'bun',
  title: 'Update dependencies (bun)',
  async isUsed(ctx) {
    return ctx.packageManager === PackageManager.Bun;
  },
  async update(ctx) {
    await selfUpdate(ctx, ['bun', 'upgrade']);
    // ncu bumps deps + the `bun@x` packageManager field across the workspace.
    await upgradeAllWorkspaces(ctx);
    await pinBunVersion(ctx);
    await cleanInstall(ctx, ['bun', 'install']);
  },
};
