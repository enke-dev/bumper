import { relative } from 'node:path';

import { allDependencies, readPackageJson, writePackageJson } from '../../../utils/fs.utils.js';
import { latestVersionInRange, viewTool } from '../../../utils/npm-registry.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { PackageJson } from '../../../utils/package.types.js';
import { isVersionRange, operatorOf } from '../../../utils/spec.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { ensureBunLatest } from '../../runtimes/bun/bun-release.utils.js';

const TYPES_BUN_PACKAGE = '@types/bun';
const BUCKETS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** Workspace dirs that declare `@types/bun` in any dependency bucket. */
async function dirsWithTypesBun(ctx: ModuleContext): Promise<string[]> {
  const dirs = await Promise.all(
    ctx.workspaces.map(async dir => {
      const pkg = await readPackageJson(dir);
      return pkg && allDependencies(pkg)[TYPES_BUN_PACKAGE] ? dir : null;
    })
  );
  return dirs.filter((dir): dir is string => dir !== null);
}

/** Rewrite every concrete `@types/bun` spec to the exact `version`, preserving the range operator
 * the manifest set (`^`/`~`/none). Compatibility ranges (e.g. a peer `>=1.1 <1.5`) are left
 * untouched. `reduce` (not `some`) so every bucket is visited, not short-circuited. */
function pinTypesBun(pkg: PackageJson, version: string): boolean {
  return BUCKETS.reduce((changed, bucket) => {
    const deps = pkg[bucket] as Record<string, string> | undefined;
    const spec = deps?.[TYPES_BUN_PACKAGE];
    if (deps && spec && !isVersionRange(spec)) {
      const next = `${operatorOf(spec)}${version}`;
      if (next !== spec) {
        deps[TYPES_BUN_PACKAGE] = next;
        return true;
      }
    }
    return changed;
  }, false);
}

/** The feature's bump, with the registry lookup injectable. `resolveInRange` defaults to the
 * real network implementation; tests pass an offline stub. Exposed separately from the `Module`
 * because the interface's `update` signature erases the extra parameter. */
export async function updateTypesBun(
  ctx: ModuleContext,
  resolveInRange: typeof latestVersionInRange = latestVersionInRange
): Promise<void> {
  const { version: bunVersion } = await ensureBunLatest(ctx);
  const dirs = await dirsWithTypesBun(ctx);
  if (dirs.length === 0) {
    return;
  }

  if (ctx.dryRun) {
    dirs.forEach(dir => {
      const label = relative(ctx.cwd, dir) || '.';
      planLine(`pin ${TYPES_BUN_PACKAGE} to newest <=${bunVersion} in ${label}`);
    });
    return;
  }

  // `@types/bun` versions mirror Bun releases (1.4.0 types the 1.4.0 runtime), but the typings
  // can lag a fresh release by a few days — so pin to the newest published version that doesn't
  // exceed the pinned Bun, which is the exact match whenever it exists. Once for the whole
  // workspace. Null (network/registry failure) leaves specs untouched.
  const version = await resolveInRange(
    TYPES_BUN_PACKAGE,
    `<=${bunVersion}`,
    viewTool(ctx.packageManager),
    ctx.cwd
  );
  if (!version) {
    return;
  }

  await Promise.all(
    dirs.map(async dir => {
      const pkg = await readPackageJson(dir);
      if (pkg && pinTypesBun(pkg, version)) {
        await writePackageJson(dir, pkg);
      }
    })
  );
}

export const typesBunFeature: Module = {
  kind: ModuleKind.Feature,
  id: 'types-bun',
  title: 'Align @types/bun to the pinned Bun release',
  async isUsed(ctx) {
    return (await dirsWithTypesBun(ctx)).length > 0;
  },
  async managedDependencies() {
    return [TYPES_BUN_PACKAGE];
  },
  update: updateTypesBun,
};
