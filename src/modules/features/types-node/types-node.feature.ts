import { relative } from 'node:path';

import { allDependencies, readPackageJson, writePackageJson } from '../../../utils/fs.utils.js';
import { latestVersionInRange, viewTool } from '../../../utils/npm-registry.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { PackageJson } from '../../../utils/package.types.js';
import { isVersionRange, operatorOf } from '../../../utils/spec.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { ensureNodeLts } from '../../runtimes/node/node-lts.utils.js';

const TYPES_NODE_PACKAGE = '@types/node';
const BUCKETS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** Workspace dirs that declare `@types/node` in any dependency bucket. */
async function dirsWithTypesNode(ctx: ModuleContext): Promise<string[]> {
  const dirs = await Promise.all(
    ctx.workspaces.map(async dir => {
      const pkg = await readPackageJson(dir);
      return pkg && allDependencies(pkg)[TYPES_NODE_PACKAGE] ? dir : null;
    })
  );
  return dirs.filter((dir): dir is string => dir !== null);
}

/** Rewrite every concrete `@types/node` spec to the exact `version`, preserving whatever range
 * operator the manifest intentionally set (`^`/`~`/none) — an exact pin stays exact, a caret
 * stays a caret — rather than truncating to a bare major. Compatibility ranges (e.g. a peer
 * `>=20 <25`) are left untouched. `reduce` (not `some`) so every bucket is visited, not
 * short-circuited. */
function pinTypesNode(pkg: PackageJson, version: string): boolean {
  return BUCKETS.reduce((changed, bucket) => {
    const deps = pkg[bucket] as Record<string, string> | undefined;
    const spec = deps?.[TYPES_NODE_PACKAGE];
    if (deps && spec && !isVersionRange(spec)) {
      const next = `${operatorOf(spec)}${version}`;
      if (next !== spec) {
        deps[TYPES_NODE_PACKAGE] = next;
        return true;
      }
    }
    return changed;
  }, false);
}

/** The feature's bump, with the registry lookup injectable. `resolveInRange` defaults to the
 * real network implementation; tests pass an offline stub. Exposed separately from the `Module`
 * because the interface's `update` signature erases the extra parameter. */
export async function updateTypesNode(
  ctx: ModuleContext,
  resolveInRange: typeof latestVersionInRange = latestVersionInRange
): Promise<void> {
  const { major } = await ensureNodeLts(ctx);
  const majorSpec = String(major);
  const dirs = await dirsWithTypesNode(ctx);
  if (dirs.length === 0) {
    return;
  }

  if (ctx.dryRun) {
    dirs.forEach(dir => {
      const label = relative(ctx.cwd, dir) || '.';
      planLine(`pin ${TYPES_NODE_PACKAGE} to latest ${majorSpec}.x in ${label}`);
    });
    return;
  }

  // Resolve the exact newest @types/node in the LTS major line (e.g. 24.13.3), so specs are
  // pinned to a full version rather than a bare major. Once for the whole workspace — every
  // manifest aligns to the same major. Null (network/registry failure) leaves specs untouched.
  const version = await resolveInRange(
    TYPES_NODE_PACKAGE,
    majorSpec,
    viewTool(ctx.packageManager),
    ctx.cwd
  );
  if (!version) {
    return;
  }

  await Promise.all(
    dirs.map(async dir => {
      const pkg = await readPackageJson(dir);
      if (pkg && pinTypesNode(pkg, version)) {
        await writePackageJson(dir, pkg);
      }
    })
  );
}

export const typesNodeFeature: Module = {
  kind: ModuleKind.Feature,
  id: 'types-node',
  title: 'Align @types/node to Node LTS major',
  async isUsed(ctx) {
    return (await dirsWithTypesNode(ctx)).length > 0;
  },
  async managedDependencies() {
    return [TYPES_NODE_PACKAGE];
  },
  update: updateTypesNode,
};
