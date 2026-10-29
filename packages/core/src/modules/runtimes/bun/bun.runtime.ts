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
import type { Pin } from '../../../utils/version-pins.utils.js';
import {
  realignDevEngines,
  realignEngines,
  realignToolConfigs,
} from '../../../utils/version-pins.utils.js';
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
 * Realign an existing `engines.bun` floor and the `devEngines` runtime + packageManager entries
 * naming bun (one binary, one release) to the pinned Bun, preserving operator + precision (see
 * `realignVersionSpec`). Never injects a field.
 */
async function alignManifestBun(dir: string, pin: Pin): Promise<void> {
  const pkg = await readPackageJson(dir);
  if (!pkg) {
    return;
  }
  // both, not short-circuited
  const changed = [
    realignEngines(pkg, 'bun', pin),
    realignDevEngines(pkg, 'bun', pin, ['runtime', 'packageManager']),
  ];
  if (changed.some(Boolean)) {
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
      planLine(`align engines.bun / devEngines to ${bun.version} where declared`);
      planLine(`align bun in any existing .tool-versions / mise.toml to ${bun.version}`);
      return;
    }
    // The binary itself is upgraded by the bun package-manager module (`bun upgrade`); this
    // module only owns the repo-side pins, so a pnpm/npm repo running on Bun is covered too.
    await Promise.all(
      ctx.workspaces.map(async dir => {
        const isRoot = dir === ctx.cwd;
        await writeVersionFile(dir, bun.version, isRoot);
        await alignManifestBun(dir, bun);
        await realignToolConfigs(dir, ['bun'], bun);
      })
    );
  },
};
