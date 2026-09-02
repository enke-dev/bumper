import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isLess, isValid, satisfies } from 'verkit';

import type { ModuleContext } from '../context/context.types.js';
import { allDependencies, pathExists, readPackageJson, writePackageJson } from './fs.utils.js';
import {
  latestVersion,
  maxSatisfyingRanges,
  peerDependenciesOf,
  viewTool,
} from './npm-registry.utils.js';
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
  maxSatisfyingRanges: (
    pkg: string,
    ranges: readonly string[],
    tool: string,
    cwd: string
  ) => Promise<string | null>;
  peerDependencies: (
    pkg: string,
    version: string,
    tool: string,
    cwd: string
  ) => Promise<Record<string, string>>;
}

const defaultLookups: RegistryLookups = {
  latestVersion,
  maxSatisfyingRanges,
  peerDependencies: peerDependenciesOf,
};

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

/** Fields through which a root manifest force-resolves a package version, per package manager. */
const OVERRIDE_FIELDS = ['overrides', 'resolutions'] as const;

/** Collect every package name keyed anywhere in an override tree (npm allows nesting). */
function overrideKeys(node: unknown): string[] {
  if (node === null || typeof node !== 'object') {
    return [];
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => [
    // `**/pkg` (yarn glob) and `pkg@1.x` (npm, scoped by range) both name the same package
    key.replace(/^(\*\*\/)+/, '').replace(/(?<!^)@[^@]*$/, ''),
    ...overrideKeys(value),
  ]);
}

/**
 * Package names under the `overrides:` block of a `pnpm-workspace.yaml` body. pnpm 11 dropped the
 * `pnpm` field in `package.json` ("no longer read by pnpm ... see the new home of each setting"),
 * so on current pnpm this file is the *only* place an override lives — miss it and every pnpm repo
 * silently keeps getting capped. Parsed line-wise like the `packages:` block in the workspace
 * detector rather than pulling in a YAML dependency: the block is a flat `name: spec` map.
 */
function parsePnpmOverrides(yaml: string): string[] {
  return yaml.split('\n').reduce<{ inBlock: boolean; names: string[] }>(
    (state, raw) => {
      const line = raw.replace(/\s+$/, '');
      if (/^overrides:\s*$/.test(line)) {
        return { ...state, inBlock: true };
      }
      if (!state.inBlock || line.trim() === '' || line.trim().startsWith('#')) {
        return state;
      }
      const entry = line.match(/^\s+['"]?(@?[^'":]+)['"]?\s*:/);
      if (entry?.[1]) {
        state.names.push(entry[1].trim());
        return state;
      }
      // a next top-level key ends the block
      return /^\S/.test(line) ? { ...state, inBlock: false } : state;
    },
    { inBlock: false, names: [] }
  ).names;
}

/**
 * Packages the repo force-resolves — npm/bun `overrides`, yarn `resolutions`, `pnpm.overrides`, or
 * the `overrides:` block of `pnpm-workspace.yaml`. Such an entry is a deliberate "this version wins
 * everywhere" statement, so a dependency's `peerDependencies` must not cap it: the repo has already
 * decided the conflict, and the installer honors the override rather than the peer.
 *
 * Without this, one dependency with a stale peer drags the whole repo backwards — an outdated
 * prettier plugin peering `3.0.0 - 3.8.x` pinned prettier to 3.8 across repos that explicitly
 * declared `overrides: { prettier: "$prettier" }` to stay on 3.9. Only cap *exemption* is implied;
 * the overridden package is still bumped to latest like any other.
 */
async function overriddenNames(cwd: string, root: PackageJson | undefined): Promise<Set<string>> {
  const workspaceFile = join(cwd, 'pnpm-workspace.yaml');
  const yaml = (await pathExists(workspaceFile)) ? await readFile(workspaceFile, 'utf8') : '';
  return new Set(
    [...overrideTrees(root).flatMap(overrideKeys), ...parsePnpmOverrides(yaml)].filter(Boolean)
  );
}

/** The override trees a root manifest declares, across all three field spellings. */
function overrideTrees(root: PackageJson | undefined): unknown[] {
  if (!root) {
    return [];
  }
  const pnpm = (root['pnpm'] as { overrides?: unknown } | undefined)?.overrides;
  return [...OVERRIDE_FIELDS.map(field => root[field]), pnpm].filter(tree => tree !== undefined);
}

/**
 * Realign concrete version pins *inside* the override trees to the same target the dependency
 * buckets get. An override exists to force a version, so leaving it behind rots the pin: the repo
 * bumps prettier while its `overrides` still forces the release from months ago. A monorepo root
 * that only overrides (no dependency of its own) can't use the `$name` back-reference, so a
 * literal version is the only option there — and it has to be maintained.
 *
 * Only string leaves that are pinnable and whose package already resolved a `latest` this run are
 * touched; `$name` references, ranges and unresolvable names are left exactly as authored.
 */
function rewriteOverrideTree(
  node: unknown,
  managed: ReadonlySet<string>,
  latest: Map<string, string | null>
): boolean {
  if (node === null || typeof node !== 'object') {
    return false;
  }
  const tree = node as Record<string, unknown>;
  return Object.entries(tree).reduce((changed, [key, value]) => {
    const name = key.replace(/^(\*\*\/)+/, '').replace(/(?<!^)@[^@]*$/, '');
    if (typeof value !== 'string') {
      return rewriteOverrideTree(value, managed, latest) || changed;
    }
    const version = managed.has(name) || !isPinnable(value) ? null : latest.get(name);
    if (!version) {
      return changed;
    }
    const next = `${operatorOf(value)}${version}`;
    if (next === value) {
      return changed;
    }
    tree[key] = next;
    return true;
  }, false);
}

/**
 * The version a direct dependency is moving to this run: the freshly-resolved `latest` when the
 * dependency is being bumped, otherwise the version currently installed under `node_modules`
 * (unchanged deps still declare peers in play). Null when neither is known — e.g. `latest` was
 * unresolvable, or the dep isn't installed.
 */
async function targetVersion(
  cwd: string,
  dep: string,
  latest: Map<string, string | null>
): Promise<string | null> {
  if (latest.has(dep)) {
    return latest.get(dep) ?? null;
  }
  return (await readPackageJson(join(cwd, 'node_modules', dep)))?.version ?? null;
}

/**
 * Version caps declared by dependencies' `peerDependencies`. A package the repo depends on may
 * constrain a shared dependency — e.g. `@enke.dev/lint` peer-pins `typescript` to `6.0.3` — and
 * bumping that dependency past the peer range would break the package. So we cap the bump to the
 * newest version satisfying *every* such peer range. The ranges are kept as a **list** (not joined
 * into one string): a peer like `^17 || ^18 || ^19` cannot be intersected with another OR-range by
 * space-joining — `A B || C` parses as `(A AND B) OR C`, so the result flips with operand order and
 * silently admits versions a peer forbids. {@link RegistryLookups.maxSatisfyingRanges} intersects
 * them correctly (AND across the list, `||` honored within each).
 *
 * Crucially, peers are read from the registry for the version each dependency is being bumped
 * *to* (see {@link targetVersion}), NOT from the stale manifest installed under `node_modules`.
 * A dep that grows a new peer in the version being installed (e.g. `@enke.dev/lint` adding a
 * `typescript@6.0.3` peer across a bump) is honored in the same run — otherwise the rewrite and
 * the subsequent install disagree and only a second run would converge. Peers in `exempt` (owned
 * by another module like `@types/node`, or force-resolved by the root manifest — see
 * {@link overriddenNames}) and non-version specs (`*`, tags, protocols) are ignored.
 */
async function collectPeerCaps(
  cwd: string,
  depNames: string[],
  latest: Map<string, string | null>,
  exempt: ReadonlySet<string>,
  tool: string,
  lookups: RegistryLookups
): Promise<Map<string, string[]>> {
  const collected = new Map<string, Set<string>>();
  await Promise.all(
    depNames.map(async dep => {
      const version = await targetVersion(cwd, dep, latest);
      if (!version) {
        return;
      }
      const peers = await lookups.peerDependencies(dep, version, tool, cwd);
      Object.entries(peers).forEach(([peer, range]) => {
        if (exempt.has(peer) || (!isPinnable(range) && !isVersionRange(range))) {
          return;
        }
        (collected.get(peer) ?? collected.set(peer, new Set()).get(peer))?.add(range);
      });
    })
  );
  return new Map([...collected].map(([peer, ranges]) => [peer, [...ranges]]));
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
 * ships with the pinned Node LTS by the npm package-manager module, not to registry-latest. A
 * `bun@x` field reuses the release the bun runtime module already resolved (when it ran), so the
 * field and `.bun-version` can't drift apart within one run. */
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
  const version =
    name === 'bun' && ctx.bunLatest
      ? ctx.bunLatest.version
      : await lookups.latestVersion(name, viewTool(ctx.packageManager), ctx.cwd);
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
  // Sequential: peer caps are read for the versions we're bumping *to*, so latest must resolve
  // first. A dep that adds a peer in its new version is then honored in this same run.
  const latest = await resolveLatest(names, tool, ctx.cwd, lookups);
  // A peer cap applies unless another module owns the package, or the root manifest force-resolves
  // it — an override already settles the conflict the peer range describes.
  const capExempt = new Set([...managed, ...(await overriddenNames(ctx.cwd, pkgs.get(ctx.cwd)))]);
  const peerCaps = await collectPeerCaps(
    ctx.cwd,
    collectDependencyNames(pkgs),
    latest,
    capExempt,
    tool,
    lookups
  );

  const root = pkgs.get(ctx.cwd);
  await Promise.all(
    [...pkgs].map(async ([dir, pkg]) => {
      const specsChanged = await rewriteSpecs(
        pkg,
        managed,
        latest,
        peerCaps,
        tool,
        ctx.cwd,
        lookups
      );
      // Override trees live in the root manifest only, whichever field spelling is used.
      const overridesChanged =
        pkg === root &&
        overrideTrees(root)
          .map(tree => rewriteOverrideTree(tree, managed, latest))
          .some(Boolean);
      if (specsChanged || overridesChanged) {
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
 * or the newest version satisfying its capping ranges when any apply. Caps are a range the
 * manifest itself declares for the package plus every `peerCaps` constraint from a dependency;
 * all are intersected (semver AND) by {@link RegistryLookups.maxSatisfyingRanges}. Returns true
 * if anything changed. `reduce` (not `some`) so every bucket + entry is visited. */
async function rewriteSpecs(
  pkg: PackageJson,
  managed: ReadonlySet<string>,
  latest: Map<string, string | null>,
  peerCaps: ReadonlyMap<string, string[]>,
  tool: string,
  cwd: string,
  lookups: RegistryLookups
): Promise<boolean> {
  const present = allDependencies(pkg);
  // Collect every capping range per package as a list — never joined into one string (see
  // collectPeerCaps): the manifest's own self-declared range plus each dependency's peer range.
  const capRanges = new Map<string, string[]>();
  cappedRanges(pkg, managed).forEach((range, name) => capRanges.set(name, [range]));
  peerCaps.forEach((ranges, name) => {
    if (!(name in present)) {
      return;
    }
    capRanges.set(name, [...new Set([...(capRanges.get(name) ?? []), ...ranges])]);
  });
  const capped = new Map(
    await Promise.all(
      [...capRanges].map(
        async ([name, ranges]) =>
          [name, await lookups.maxSatisfyingRanges(name, ranges, tool, cwd)] as const
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
      const capped_ = capRanges.has(name);
      const version = capped_ ? capped.get(name) : latest.get(name);
      if (!version) {
        return acc;
      }
      // Never walk a pin *backwards* when the current version is already acceptable:
      //  - plain path: the `latest` dist-tag can trail a pinned prerelease (e.g.
      //    `vitepress@2.0.0-alpha.13` while `latest` is `1.6.4`, the alpha under the `next` tag).
      //  - capped path: a peer cap must only lower a version that *violates* the peer ranges. A
      //    pin still satisfying them — typically a prerelease the stable-only cap resolution
      //    skipped — must be kept, not downgraded to the newest stable.
      const current = spec.replace(/^[\^~]/, '');
      if (isValid(current) && isLess(version, current)) {
        const currentViolatesCaps =
          capped_ && !(capRanges.get(name) ?? []).every(range => satisfies(current, range));
        if (!currentViolatesCaps) {
          return acc;
        }
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
