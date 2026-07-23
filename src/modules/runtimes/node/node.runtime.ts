import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Runtime, VersionManager } from '../../../context/context.types.js';
import { execOk, toolExists } from '../../../utils/exec.utils.js';
import {
  anyExists,
  pathExists,
  readPackageJson,
  writePackageJson,
} from '../../../utils/fs.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import { realignVersionSpec } from '../../../utils/spec.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { ensureNodeLts } from './node-lts.utils.js';

async function anyWorkspaceHasNodeVersionFile(ctx: ModuleContext): Promise<boolean> {
  const present = await Promise.all(
    ctx.workspaces.map(dir => anyExists(dir, ['.node-version', '.nvmrc']))
  );
  return present.some(Boolean);
}

/**
 * Write `v<version>` to a workspace version file. `ensure` forces the write (used for the root
 * `.node-version`, bumper's canonical pin); otherwise the file is only rewritten when it already
 * exists — so a repo that keeps a `.nvmrc` stays aligned, but no redundant dotfile is imposed on
 * one that doesn't.
 */
async function writeVersionFile(
  dir: string,
  name: string,
  version: string,
  ensure: boolean
): Promise<void> {
  const target = join(dir, name);
  if (ensure || (await pathExists(target))) {
    await writeFile(target, `v${version}\n`);
  }
}

/**
 * Realign an existing `engines.node` floor to the pinned Node, preserving the operator + precision
 * the manifest declared (see `repinNodeSpec`). No-op when the manifest declares no `engines.node`,
 * or when its spec is a shape we don't rewrite (a compound range is left as authored) — never
 * injects an `engines` field where there was none.
 */
async function alignEnginesNode(dir: string, version: string, major: number): Promise<void> {
  const pkg = await readPackageJson(dir);
  const current = pkg?.engines?.['node'];
  if (!pkg || !pkg.engines || !current) {
    return;
  }
  const next = realignVersionSpec(current, version, major);
  if (next && next !== current) {
    pkg.engines['node'] = next;
    await writePackageJson(dir, pkg);
  }
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
      planLine(`write v${lts.version} to .node-version + any existing .nvmrc (root + members)`);
      planLine(`align engines.node to ${lts.version} where declared`);
      return;
    }
    await installNode(ctx, lts.version);
    await Promise.all(
      ctx.workspaces.map(async dir => {
        // Root always gets the canonical `.node-version`; members only if they already pin one
        // (mirrors update.sh). `.nvmrc` and `engines.node` are aligned only where they exist.
        const isRoot = dir === ctx.cwd;
        await writeVersionFile(dir, '.node-version', lts.version, isRoot);
        await writeVersionFile(dir, '.nvmrc', lts.version, false);
        await alignEnginesNode(dir, lts.version, lts.major);
      })
    );
  },
};
