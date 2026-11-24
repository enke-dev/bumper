import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { getMajor, getMinor, isLessThan, isStable, isValid, sortReversed } from 'verkit';

import {
  assertPublishAgeSupport,
  cargoGate,
  findCargoDirs,
  parseCargoLock,
  publishedCrateVersions,
  tooNewCrate,
  unmetRequirement,
} from '../../../utils/cargo.utils.js';
import { execOk } from '../../../utils/exec.utils.js';
import { allDependencies, readPackageJson } from '../../../utils/fs.utils.js';
import { planLine, stepNote } from '../../../utils/output.utils.js';
import type { PackageJson } from '../../../utils/package.types.js';
import { operatorOf } from '../../../utils/spec.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';

const PLUGIN_PACKAGE = /^@tauri-apps\/plugin-(.+)$/;
const CORE_PACKAGE = '@tauri-apps/api';

/** A tauri JavaScript package and the crate it talks to over IPC. */
interface CratePair {
  pkg: string;
  /** The version the JavaScript package is pinned to. */
  version: string;
  crate: string;
  /**
   * How closely the crate follows: a plugin's crate shares its package's version, the core
   * `tauri` crate is versioned apart from `@tauri-apps/api` and only shares its minor, the one
   * the tauri CLI requires ("Found version mismatched Tauri packages").
   */
  match: 'version' | 'minor';
}

/** A cargo dir and the pairs of the JavaScript package it belongs to. */
interface TauriTarget {
  dir: string;
  pairs: CratePair[];
}

/**
 * The tauri packages a package pins, paired with their crates (`@tauri-apps/plugin-http` ↔
 * `tauri-plugin-http`, `@tauri-apps/api` ↔ `tauri`). Only exact pins: a range doesn't say which
 * version is installed.
 */
function cratePairs(pkg: PackageJson | null): CratePair[] {
  return Object.entries(pkg ? allDependencies(pkg) : {}).flatMap(([name, spec]) => {
    const suffix = PLUGIN_PACKAGE.exec(name)?.[1];
    const crate = name === CORE_PACKAGE ? 'tauri' : suffix && `tauri-plugin-${suffix}`;
    const match = name === CORE_PACKAGE ? 'minor' : 'version';
    return crate && operatorOf(spec) === '' && isValid(spec)
      ? [{ pkg: name, version: spec, crate, match } as const]
      : [];
  });
}

/** Each cargo dir with the pairs of the workspace package it lives in (the deepest one). */
async function tauriTargets(ctx: ModuleContext): Promise<TauriTarget[]> {
  const deepestFirst = [...ctx.workspaces].sort((a, b) => b.length - a.length);
  const packages = new Map(
    await Promise.all(ctx.workspaces.map(async dir => [dir, await readPackageJson(dir)] as const))
  );
  return (await findCargoDirs(ctx))
    .map(dir => {
      const owner = deepestFirst.find(ws => dir === ws || dir.startsWith(`${ws}${sep}`));
      return { dir, pairs: cratePairs(owner ? (packages.get(owner) ?? null) : null) };
    })
    .filter(target => target.pairs.length > 0);
}

/** The crates.io versions of a pair's crate locked in a target's lockfile, read fresh: each
 * `cargo update` before may have moved them. */
async function lockedVersions(target: TauriTarget, pair: CratePair): Promise<string[]> {
  const lock = parseCargoLock(await readFile(join(target.dir, 'Cargo.lock'), 'utf8'));
  return lock
    .filter(crate => crate.cratesIo && crate.name === pair.crate)
    .map(crate => crate.version);
}

/** The locked version sharing the package's major, the one a lock can pair, if any. */
function pairedVersion(locked: string[], pair: CratePair): string | undefined {
  return locked.find(version => getMajor(version) === getMajor(pair.version));
}

/**
 * The stable versions of a pair's crate that fit its package, best first: a plugin's crate up to
 * the package's version (a plugin release can skip one side, then the newest below has to do),
 * the core crate anywhere within the package's minor.
 */
export function fittingVersions(published: string[], pair: CratePair): string[] {
  const fits = (version: string) =>
    isStable(version) &&
    getMajor(version) === getMajor(pair.version) &&
    (pair.match === 'minor'
      ? getMinor(version) === getMinor(pair.version)
      : !isLessThan(pair.version, version));
  return sortReversed(published.filter(fits));
}

/** Lookups the feature makes, injectable for tests. */
export interface TauriDeps {
  run: typeof execOk;
  versionsOf: (crate: string) => Promise<string[]>;
}

/** One crate to lock, and where. */
interface LockJob {
  target: TauriTarget;
  pair: CratePair;
  /** The locked version the candidates replace. */
  current: string;
  env: Record<string, string>;
  deps: TauriDeps;
  label: string;
  /** The current lock already fits the package; newer candidates are only an upgrade. */
  fits: boolean;
}

/**
 * Lock the crate to the first of `versions` the cooldown lets through. `refused` collects the
 * crates cargo named as too young on the way: often a dependency released along with the
 * candidate, sometimes one the manifest requires anyway.
 */
async function lockFirst(job: LockJob, versions: string[], refused: string[] = []): Promise<void> {
  const { target, pair, current, label } = job;
  const [version, ...rest] = versions;
  if (version === undefined) {
    // a fitting lock missing a newer patch is no mismatch worth a note
    if (!job.fits) {
      const others = [...new Set(refused)].filter(crate => crate !== '' && crate !== pair.crate);
      const cause = others.length > 0 ? ` (cargo refused ${others.join(', ')})` : '';
      stepNote(
        `${label}: ${pair.crate} fitting ${pair.pkg} ${pair.version} is younger than the release age${cause}, kept ${current}`
      );
    }
    return;
  }
  const spec = `${pair.crate}@${current}`;
  // the crate cargo refused as too young, or null once locked or held
  const refusal = await job.deps
    .run(['cargo', 'update', '-p', spec, '--precise', version], { cwd: target.dir, env: job.env })
    .then(
      () => null,
      (error: unknown): string | null => {
        const message = error instanceof Error ? error.message : String(error);
        // under the cooldown, an older version may still pass
        const young = tooNewCrate(message);
        if (young !== null) {
          return young;
        }
        const requirement = unmetRequirement(message);
        if (requirement !== null) {
          stepNote(`${label}: ${requirement} rules out ${pair.crate} ${version}, kept ${current}`);
          return null;
        }
        throw error;
      }
    );
  if (refusal !== null) {
    await lockFirst(job, rest, [...refused, refusal]);
  }
}

/** Lock one crate to the version of its JavaScript package, or the closest that fits. */
async function alignPair(
  ctx: ModuleContext,
  target: TauriTarget,
  pair: CratePair,
  locked: string[],
  env: Record<string, string>,
  deps: TauriDeps
): Promise<void> {
  const label = relative(ctx.cwd, target.dir) || '.';
  const current = pairedVersion(locked, pair);
  if (current === undefined) {
    // a major apart needs a manifest edit, not a lock
    stepNote(
      `${label}: ${pair.crate} ${locked.join(', ')} is a major apart from ${pair.pkg} ${pair.version}, upgrade by hand`
    );
    return;
  }
  if (pair.match === 'version' && current === pair.version) {
    return;
  }

  const published = await deps.versionsOf(pair.crate).catch(() => null);
  if (published === null) {
    stepNote(`${label}: crates.io index unreachable for ${pair.crate}, kept ${current}`);
    return;
  }
  const fitting = fittingVersions(published, pair);
  const best = fitting[0];
  if (best === undefined) {
    stepNote(
      `${label}: no ${pair.crate} on crates.io fits ${pair.pkg} ${pair.version}, kept ${current}`
    );
    return;
  }
  if (pair.match === 'version' && best !== pair.version && best !== current) {
    stepNote(`${label}: no ${pair.crate} ${pair.version} on crates.io, newest below is ${best}`);
  }
  // only what beats the current lock: a fitting current one stays unless a newer one passes
  const at = fitting.indexOf(current);
  const candidates = at === -1 ? fitting : fitting.slice(0, at);
  if (candidates.length === 0) {
    return;
  }
  if (ctx.dryRun) {
    planLine(`align ${pair.crate} ${current} with ${pair.pkg} ${pair.version} in ${label}`);
    return;
  }
  // a plugin crate fits only on its package's version, which returned above
  const fits = pair.match === 'minor' && at !== -1;
  await lockFirst({ target, pair, current, env, deps, label, fits }, candidates);
}

/** The feature's update, with cargo and the crates.io index injectable for tests. */
export async function updateTauri(
  ctx: ModuleContext,
  deps: TauriDeps = {
    run: execOk,
    versionsOf: crate => publishedCrateVersions(crate),
  }
): Promise<void> {
  const targets = await tauriTargets(ctx);
  // sequential: each `cargo update` rewrites the lockfile the next one reads
  await targets.reduce(async (previous, target) => {
    await previous;
    const { env, gated } = await cargoGate(ctx, target.dir);
    if (gated && !ctx.dryRun) {
      // in the dir, as rustup picks the toolchain by it
      await assertPublishAgeSupport(deps.run, target.dir);
    }
    await target.pairs.reduce(async (before, pair) => {
      await before;
      const locked = await lockedVersions(target, pair);
      if (locked.length > 0) {
        await alignPair(ctx, target, pair, locked, env, deps);
      }
    }, Promise.resolve());
  }, Promise.resolve());
}

export const tauriFeature: Module = {
  kind: ModuleKind.Feature,
  id: 'tauri',
  title: 'Align tauri crates with their JavaScript packages',
  async isUsed(ctx) {
    const toggle = ctx.config.modules['tauri'];
    if (toggle !== undefined) {
      return toggle;
    }
    return (await tauriTargets(ctx)).length > 0;
  },
  // only crates the feature can lock: one a major apart is left to the cargo update
  async managedCrates(ctx) {
    const owned = await Promise.all(
      (await tauriTargets(ctx)).flatMap(target =>
        target.pairs.map(async pair =>
          pairedVersion(await lockedVersions(target, pair), pair) === undefined ? null : pair.crate
        )
      )
    );
    return [...new Set(owned.filter((crate): crate is string => crate !== null))];
  },
  update: ctx => updateTauri(ctx),
};
