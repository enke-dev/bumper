import { readFile, writeFile } from 'node:fs/promises';

import {
  allDependencies,
  collectFiles,
  readPackageJson,
  writePackageJson,
} from '../../../utils/fs.utils.js';
import { latestVersionInRange, viewTool } from '../../../utils/npm-registry.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { PackageJson } from '../../../utils/package.types.js';
import { operatorOf } from '../../../utils/spec.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { ensureNodeLts } from '../../runtimes/node/node-lts.utils.js';

const BASE = /^@tsconfig\/node(\d+)$/;
const TSCONFIG_GLOB = '**/tsconfig*.json';
const BUCKETS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

const baseName = (major: number) => `@tsconfig/node${major}`;

/** The workspace manifests with the `@tsconfig/node<major>` bases they depend on. */
async function manifestsWithBases(
  ctx: ModuleContext
): Promise<{ dir: string; pkg: PackageJson; bases: [number, string][] }[]> {
  const manifests = await Promise.all(
    ctx.workspaces.map(async dir => {
      const pkg = await readPackageJson(dir);
      const bases = Object.entries(pkg ? allDependencies(pkg) : {}).flatMap(
        ([name, spec]): [number, string][] => {
          const major = BASE.exec(name)?.[1];
          return major ? [[Number(major), spec]] : [];
        }
      );
      return pkg && bases.length > 0 ? [{ dir, pkg, bases }] : [];
    })
  );
  return manifests.flat();
}

/** A version spec (`^22.0.2`, `22`) moves to the new release with its operator; a floating one
 * (`latest`, `*`) is kept as written. */
const respec = (spec: string, version: string) =>
  /^[\^~]?\d/.test(spec) ? `${operatorOf(spec)}${version}` : spec;

/** Swap the `from` base for `to` in every dependency bucket, keeping the key order; a bucket
 * listing `to` already keeps that spec and just drops `from`. */
function swapBase(pkg: PackageJson, from: string, to: string, version: string): boolean {
  return BUCKETS.reduce((changed, bucket) => {
    const deps = pkg[bucket];
    if (!deps?.[from]) {
      return changed;
    }
    const listed = to in deps;
    pkg[bucket] = Object.fromEntries(
      Object.entries(deps).flatMap(([name, spec]): [string, string][] => {
        if (name !== from) {
          return [[name, spec]];
        }
        return listed ? [] : [[to, respec(spec, version)]];
      })
    );
    return true;
  }, false);
}

/** Point every `tsconfig*.json` reference to the `from` base at `to`, as text so comments and
 * formatting stay. */
async function swapExtends(ctx: ModuleContext, froms: readonly number[], to: number) {
  const files = await collectFiles(ctx.cwd, TSCONFIG_GLOB, ctx.config.exclude);
  const pattern = new RegExp(`@tsconfig/node(?:${froms.join('|')})(?!\\d)`, 'g');
  await Promise.all(
    files.map(async file => {
      const text = await readFile(file, 'utf8');
      const next = text.replace(pattern, baseName(to));
      if (next !== text) {
        await writeFile(file, next);
      }
    })
  );
}

/** The feature's swap, with the registry lookup injectable (see `updateTypesNode`). */
export async function updateTsconfigNode(
  ctx: ModuleContext,
  resolveInRange: typeof latestVersionInRange = latestVersionInRange
): Promise<void> {
  const { major } = await ensureNodeLts(ctx);
  const manifests = await manifestsWithBases(ctx);
  const bases = manifests.flatMap(manifest => manifest.bases);
  // only older bases move up; a protocol spec (`catalog:`, `workspace:`) is resolved elsewhere,
  // so its base stays put everywhere to keep the tsconfigs in step with the manifests
  const held = new Set(bases.filter(([, spec]) => spec.includes(':')).map(([from]) => from));
  const froms = [...new Set(bases.map(([from]) => from))].filter(
    from => from < major && !held.has(from)
  );
  if (froms.length === 0) {
    return;
  }
  const to = baseName(major);
  if (ctx.dryRun) {
    froms.forEach(from =>
      planLine(`swap ${baseName(from)} → ${to} (manifests + tsconfig extends)`)
    );
    return;
  }
  // a base for a fresh LTS may not be published yet: then everything stays until it is
  const version = await resolveInRange(to, '*', viewTool(ctx.packageManager), ctx.cwd, {
    policy: ctx.releaseAge,
  });
  if (!version) {
    return;
  }
  await Promise.all(
    manifests.map(async ({ dir, pkg }) => {
      const changed = froms.map(from => swapBase(pkg, baseName(from), to, version));
      if (changed.some(Boolean)) {
        await writePackageJson(dir, pkg);
      }
    })
  );
  await swapExtends(ctx, froms, major);
}

export const tsconfigNodeFeature: Module = {
  kind: ModuleKind.Feature,
  id: 'tsconfig-node',
  title: 'Move @tsconfig/node<major> to the Node LTS major',
  async isUsed(ctx) {
    const toggle = ctx.config.modules['tsconfig-node'];
    if (toggle !== undefined) {
      return toggle;
    }
    return (await manifestsWithBases(ctx)).length > 0;
  },
  update: updateTsconfigNode,
};
