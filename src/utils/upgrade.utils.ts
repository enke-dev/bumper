import { join } from 'node:path';

import type { ModuleContext } from '../context/context.types.js';
import { allDependencies, readPackageJson, writePackageJson } from './fs.utils.js';
import { latestVersion, latestVersionInRange, viewTool } from './npm-registry.utils.js';
import { planLine } from './output.utils.js';
import type { PackageJson } from './package.types.js';
import { isPinnable, isVersionRange, operatorOf } from './spec.utils.js';

const BUCKETS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

const CONCURRENCY = 8;

/**
 * The registry lookups the orchestrator needs. Defaults to the real, network-backed
 * implementations; tests inject offline stubs so the whole bump can be exercised without
 * a registry (and without module mocking, keeping the test runtime-agnostic).
 */
export interface RegistryLookups {
  latestVersion: (pkg: string, tool: string, cwd: string) => Promise<string | null>;
  latestVersionInRange: (
    pkg: string,
    range: string,
    tool: string,
    cwd: string
  ) => Promise<string | null>;
}

const defaultLookups: RegistryLookups = { latestVersion, latestVersionInRange };

async function collectPackages(ctx: ModuleContext): Promise<Map<string, PackageJson>> {
  const entries = await Promise.all(
    ctx.workspaces.map(async dir => [dir, await readPackageJson(dir)] as const)
  );
  return new Map(entries.filter((entry): entry is [string, PackageJson] => entry[1] !== null));
}

/** Unique bumpable dependency names across all manifests, minus module-managed ones. */
function collectNames(pkgs: Map<string, PackageJson>, managed: ReadonlySet<string>): string[] {
  const names = [...pkgs.values()]
    .flatMap(pkg => Object.entries(allDependencies(pkg)))
    .filter(([name, spec]) => !managed.has(name) && isPinnable(spec))
    .map(([name]) => name);
  return [...new Set(names)];
}

/** Every direct dependency name across all manifests (all buckets, managed included). */
function collectDependencyNames(pkgs: Map<string, PackageJson>): string[] {
  return [...new Set([...pkgs.values()].flatMap(pkg => Object.keys(allDependencies(pkg))))];
}

/**
 * Version caps declared by installed dependencies' `peerDependencies`. A package the repo
 * depends on may constrain a shared dependency — e.g. `@enke.dev/lint` peer-pins `typescript`
 * to `6.0.3` — and bumping that dependency past the peer range would break the installed
 * package. So we cap the bump to the newest version satisfying *every* such peer range,
 * intersecting multiple constraints (semver AND, space-joined). Read from the manifests
 * actually installed under `node_modules`, i.e. the versions in play this run. Managed peers
 * (owned by another module, e.g. `@types/node`) and non-version specs (`*`, tags, protocols)
 * are ignored.
 */
async function collectPeerCaps(
  cwd: string,
  depNames: string[],
  managed: ReadonlySet<string>
): Promise<Map<string, string>> {
  const collected = new Map<string, Set<string>>();
  await Promise.all(
    depNames.map(async dep => {
      const peers = (await readPackageJson(join(cwd, 'node_modules', dep)))?.peerDependencies;
      if (!peers) {
        return;
      }
      Object.entries(peers).forEach(([peer, range]) => {
        if (managed.has(peer) || (!isPinnable(range) && !isVersionRange(range))) {
          return;
        }
        (collected.get(peer) ?? collected.set(peer, new Set()).get(peer))?.add(range);
      });
    })
  );
  return new Map([...collected].map(([peer, ranges]) => [peer, [...ranges].join(' ')]));
}

/**
 * Resolve latest versions for many packages with bounded concurrency: each lookup is
 * gated on the one `CONCURRENCY` slots earlier finishing, so at most `CONCURRENCY` run at
 * once and a freed slot is picked up immediately (no batch barrier).
 */
async function resolveLatest(
  names: string[],
  tool: string,
  cwd: string,
  lookups: RegistryLookups
): Promise<Map<string, string | null>> {
  const resolved: Promise<[string, string | null]>[] = [];
  names.forEach((name, index) => {
    const slot = index < CONCURRENCY ? Promise.resolve() : resolved[index - CONCURRENCY];
    resolved[index] = (slot ?? Promise.resolve()).then(
      async () => [name, await lookups.latestVersion(name, tool, cwd)] as [string, string | null]
    );
  });
  return new Map(await Promise.all(resolved));
}

/** Bump the root `packageManager` field (e.g. `pnpm@x`, `bun@x`) to latest. npm is excluded:
 * it isn't published/installed independently of Node, so its field is aligned to the npm that
 * ships with the pinned Node LTS by the npm package-manager module, not to registry-latest. */
async function bumpPackageManagerField(
  ctx: ModuleContext,
  root: PackageJson | undefined,
  lookups: RegistryLookups
): Promise<void> {
  const match = root?.packageManager?.match(/^([a-z]+)@(.+)$/);
  const name = match?.[1];
  if (!root || !name || name === 'npm') {
    return;
  }
  const version = await lookups.latestVersion(name, viewTool(ctx.packageManager), ctx.cwd);
  if (!version) {
    return;
  }
  const next = `${name}@${version}`;
  if (next !== root.packageManager) {
    root.packageManager = next;
    await writePackageJson(ctx.cwd, root);
  }
}

/** Rewrite every bumpable dependency spec across the workspace to latest. */
export async function upgradeAllWorkspaces(
  ctx: ModuleContext,
  lookups: RegistryLookups = defaultLookups
): Promise<void> {
  const managed = ctx.managedDependencies ?? new Set<string>();
  const pkgs = await collectPackages(ctx);
  const names = collectNames(pkgs, managed);

  if (ctx.dryRun) {
    planLine(`resolve latest for ${names.length} dependency(ies) across ${pkgs.size} manifest(s)`);
    planLine('rewrite package.json specs (preserving ^/~), bump packageManager field');
    return;
  }

  const tool = viewTool(ctx.packageManager);
  const [latest, peerCaps] = await Promise.all([
    resolveLatest(names, tool, ctx.cwd, lookups),
    collectPeerCaps(ctx.cwd, collectDependencyNames(pkgs), managed),
  ]);

  await Promise.all(
    [...pkgs].map(async ([dir, pkg]) => {
      if (await rewriteSpecs(pkg, managed, latest, peerCaps, tool, ctx.cwd, lookups)) {
        await writePackageJson(dir, pkg);
      }
    })
  );

  await bumpPackageManagerField(ctx, pkgs.get(ctx.cwd), lookups);
}

/**
 * Packages this manifest constrains via a self-declared compatibility range (e.g. an
 * optional peer `>=x <y`). A concrete spec for such a package is capped to the newest
 * version within its range rather than global latest — the range itself is left untouched.
 */
function cappedRanges(pkg: PackageJson, managed: ReadonlySet<string>): Map<string, string> {
  const caps = new Map<string, string>();
  BUCKETS.forEach(bucket => {
    const deps = pkg[bucket] as Record<string, string> | undefined;
    if (!deps) {
      return;
    }
    Object.entries(deps).forEach(([name, spec]) => {
      if (!managed.has(name) && !caps.has(name) && isVersionRange(spec)) {
        caps.set(name, spec);
      }
    });
  });
  return caps;
}

/** Rewrite every bumpable, unmanaged spec in `pkg` to its resolved target — global latest,
 * or the newest version within a capping range when one applies. A cap is either a range the
 * manifest itself declares for the package or a `peerCaps` constraint from an installed
 * dependency; when both exist they are intersected (semver AND). Returns true if anything
 * changed. `reduce` (not `some`) so every bucket + entry is visited. */
async function rewriteSpecs(
  pkg: PackageJson,
  managed: ReadonlySet<string>,
  latest: Map<string, string | null>,
  peerCaps: ReadonlyMap<string, string>,
  tool: string,
  cwd: string,
  lookups: RegistryLookups
): Promise<boolean> {
  const present = allDependencies(pkg);
  const caps = cappedRanges(pkg, managed);
  peerCaps.forEach((range, name) => {
    if (!(name in present)) {
      return;
    }
    const own = caps.get(name);
    caps.set(name, own ? `${own} ${range}` : range);
  });
  const capped = new Map(
    await Promise.all(
      [...caps].map(
        async ([name, range]) =>
          [name, await lookups.latestVersionInRange(name, range, tool, cwd)] as const
      )
    )
  );

  return BUCKETS.reduce((bucketChanged, bucket) => {
    const deps = pkg[bucket] as Record<string, string> | undefined;
    if (!deps) {
      return bucketChanged;
    }
    const entryChanged = Object.entries(deps).reduce((acc, [name, spec]) => {
      if (managed.has(name) || !isPinnable(spec)) {
        return acc;
      }
      const version = caps.has(name) ? capped.get(name) : latest.get(name);
      if (!version) {
        return acc;
      }
      const next = `${operatorOf(spec)}${version}`;
      if (next === spec) {
        return acc;
      }
      deps[name] = next;
      return true;
    }, false);
    return bucketChanged || entryChanged;
  }, false);
}
