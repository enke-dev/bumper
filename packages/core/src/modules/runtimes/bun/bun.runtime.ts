import { join } from 'node:path';

import { Runtime } from '../../../context/context.types.js';
import {
  anyExists,
  pathExists,
  readPackageJson,
  writeLine,
  writePackageJson,
} from '../../../utils/fs.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import { realignVersionSpec } from '../../../utils/spec.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { ensureBunLatest } from './bun-release.utils.js';

const VERSION_FILE = '.bun-version';

async function anyWorkspaceHasBunVersionFile(ctx: ModuleContext): Promise<boolean> {
  const present = await Promise.all(ctx.workspaces.map(dir => anyExists(dir, [VERSION_FILE])));
  return present.some(Boolean);
}

/**
 * Write the bare version (no `v` — what `setup-bun`'s `bun-version-file`, mise and asdf read) to
 * a workspace's `.bun-version`. `ensure` forces the write (the root file is bumper's canonical
 * pin); otherwise only an existing file is rewritten, so members that pin one stay aligned and no
 * redundant dotfile is imposed on those that don't.
 */
async function writeVersionFile(dir: string, version: string, ensure: boolean): Promise<void> {
  const target = join(dir, VERSION_FILE);
  if (ensure || (await pathExists(target))) {
    await writeLine(target, version);
  }
}

/**
 * Realign an existing `engines.bun` floor to the pinned Bun, preserving the operator + precision
 * the manifest declared (see `realignVersionSpec`). Never injects an `engines` field.
 */
async function alignEnginesBun(dir: string, version: string, major: number): Promise<void> {
  const pkg = await readPackageJson(dir);
  const current = pkg?.engines?.['bun'];
  if (!pkg || !pkg.engines || !current) {
    return;
  }
  const next = realignVersionSpec(current, version, major);
  if (next && next !== current) {
    pkg.engines['bun'] = next;
    await writePackageJson(dir, pkg);
  }
}

export const bunRuntime: Module = {
  kind: ModuleKind.Runtime,
  id: 'bun-runtime',
  title: 'Update Bun to latest release',
  async isUsed(ctx) {
    return ctx.runtime === Runtime.Bun || anyWorkspaceHasBunVersionFile(ctx);
  },
  async update(ctx) {
    const bun = await ensureBunLatest(ctx);
    if (ctx.dryRun) {
      planLine(`write ${bun.version} to .bun-version (root + any member pinning one)`);
      planLine(`align engines.bun to ${bun.version} where declared`);
      return;
    }
    // The binary itself is upgraded by the bun package-manager module (`bun upgrade`); this
    // module only owns the repo-side pins, so a pnpm/npm repo running on Bun is covered too.
    await Promise.all(
      ctx.workspaces.map(async dir => {
        const isRoot = dir === ctx.cwd;
        await writeVersionFile(dir, bun.version, isRoot);
        await alignEnginesBun(dir, bun.version, bun.major);
      })
    );
  },
};
