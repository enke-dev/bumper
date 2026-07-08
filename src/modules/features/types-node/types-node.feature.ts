import { relative } from 'node:path';

import { allDependencies, readPackageJson, writePackageJson } from '../../../utils/fs.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { PackageJson } from '../../../utils/package.types.js';
import { isVersionRange } from '../../../utils/spec.utils.js';
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

/** Rewrite every `@types/node` spec to the bare major (itself a `major.x` pin). Compatibility
 * ranges (e.g. a peer `>=20 <25`) are left untouched. `reduce` (not `some`) so every bucket is
 * visited, not short-circuited. */
function pinTypesNode(pkg: PackageJson, major: string): boolean {
  return BUCKETS.reduce((changed, bucket) => {
    const deps = pkg[bucket] as Record<string, string> | undefined;
    const spec = deps?.[TYPES_NODE_PACKAGE];
    if (deps && spec && !isVersionRange(spec)) {
      deps[TYPES_NODE_PACKAGE] = major;
      return true;
    }
    return changed;
  }, false);
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
  async update(ctx) {
    const { major } = await ensureNodeLts(ctx);
    const majorSpec = String(major);
    const dirs = await dirsWithTypesNode(ctx);
    await Promise.all(
      dirs.map(async dir => {
        const label = relative(ctx.cwd, dir) || '.';
        if (ctx.dryRun) {
          planLine(`pin ${TYPES_NODE_PACKAGE}@${majorSpec} in ${label}`);
          return;
        }
        const pkg = await readPackageJson(dir);
        if (pkg && pinTypesNode(pkg, majorSpec)) {
          await writePackageJson(dir, pkg);
        }
      })
    );
  },
};
