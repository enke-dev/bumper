import { PackageManager } from '../../../context/context.types.js';
import { approveScripts, cleanInstall } from '../../../utils/deps.utils.js';
import { readPackageJson, writePackageJson } from '../../../utils/fs.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import { upgradeAllWorkspaces } from '../../../utils/upgrade.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { ensureNodeLts } from '../../runtimes/node/node-lts.utils.js';

/**
 * Align the root `packageManager` field to the npm bundled with the pinned Node LTS. npm ships
 * with Node rather than being installed independently, so pinning it to registry-latest (as the
 * generic bump does for pnpm/bun) would name a version nobody actually runs. Only rewrites an
 * existing `npm@…` field — never adds one — and only when the LTS carries a known npm version.
 */
export async function alignNpmToNodeLts(ctx: ModuleContext): Promise<void> {
  const root = await readPackageJson(ctx.cwd);
  if (!root?.packageManager?.startsWith('npm@')) {
    return;
  }
  const { npm } = await ensureNodeLts(ctx);
  if (!npm) {
    return;
  }
  const next = `npm@${npm}`;
  if (next === root.packageManager) {
    return;
  }
  if (ctx.dryRun) {
    planLine(`set packageManager to ${next} (bundled with Node LTS)`);
    return;
  }
  root.packageManager = next;
  await writePackageJson(ctx.cwd, root);
}

export const npmPackageManager: Module = {
  kind: ModuleKind.PackageManager,
  id: 'npm',
  title: 'Update dependencies (npm)',
  async isUsed(ctx) {
    return ctx.packageManager === PackageManager.Npm;
  },
  async update(ctx) {
    await upgradeAllWorkspaces(ctx);
    await alignNpmToNodeLts(ctx);
    await cleanInstall(ctx, ['npm', 'install']);
    await approveScripts(ctx, ['npm', 'approve-scripts', '--all']);
  },
};
