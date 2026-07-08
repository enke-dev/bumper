import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Runtime, VersionManager } from '../../../context/context.types.js';
import { execOk, toolExists } from '../../../utils/exec.utils.js';
import { anyExists, pathExists } from '../../../utils/fs.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { ensureNodeLts } from './node-lts.utils.js';

async function anyWorkspaceHasNodeVersionFile(ctx: ModuleContext): Promise<boolean> {
  const present = await Promise.all(
    ctx.workspaces.map(dir => anyExists(dir, ['.node-version', '.nvmrc']))
  );
  return present.some(Boolean);
}

/** Install the target Node via the detected version manager (best effort). */
async function installNode(ctx: ModuleContext, version: string): Promise<void> {
  switch (ctx.versionManager) {
    case VersionManager.Fnm:
      if (toolExists('fnm')) {
        await execOk(['fnm', 'install', version]);
      }
      return;
    case VersionManager.Asdf:
      if (toolExists('asdf')) {
        await execOk(['asdf', 'install', 'nodejs', version]);
      }
      return;
    default:
      // nvm is a shell function (not spawnable); None => write-only.
      return;
  }
}

export const nodeRuntime: Module = {
  kind: ModuleKind.Runtime,
  id: 'node',
  title: 'Update Node.js to current LTS',
  async isUsed(ctx) {
    return ctx.runtime === Runtime.Node || anyWorkspaceHasNodeVersionFile(ctx);
  },
  async update(ctx) {
    const lts = await ensureNodeLts(ctx);
    if (ctx.dryRun) {
      planLine(`install Node ${lts.version} via ${ctx.versionManager}`);
      planLine(`write v${lts.version} to .node-version (root + existing package files)`);
      return;
    }
    await installNode(ctx, lts.version);
    await Promise.all(
      ctx.workspaces.map(async dir => {
        const target = join(dir, '.node-version');
        // Root always; members only if they already pin a version (mirrors update.sh).
        if (dir === ctx.cwd || (await pathExists(target))) {
          await writeFile(target, `v${lts.version}\n`);
        }
      })
    );
  },
};
