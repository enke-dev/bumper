import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { compare, getMajor, getMinor, getPatch, isLessThan, isValid } from 'verkit';

import type { ModuleContext } from '../context/context.types.js';
import type { Change } from './commit.utils.js';
import type { ExecResult } from './exec.utils.js';
import { exec, execOk } from './exec.utils.js';
import { collectFiles, pathExists } from './fs.utils.js';
import { curlText } from './npm-registry.utils.js';
import type { ReleaseAgePolicy } from './release-age.utils.js';

/** Cargo lockfiles, matched anywhere in the tree. */
export const CARGO_LOCK_GLOB = '**/Cargo.lock';

/** The first cargo honoring `min-publish-age`; older ones warn and resolve without the gate. */
export const PUBLISH_AGE_CARGO = '1.100.0';

/** One `[[package]]` entry of a `Cargo.lock`. */
export interface LockedCrate {
  name: string;
  version: string;
  /** From a registry (crates.io or another), not a path or git dependency. */
  registry: boolean;
  /** From crates.io, the registry the sparse index lookups ask. */
  cratesIo: boolean;
}

/** A crate `cargo update` moves, as it reports the move. */
export interface CrateMove {
  name: string;
  from: string;
  to: string;
}

/** What `cargo update` reports it does (or would do, on `--dry-run`). */
export interface CargoUpdatePlan {
  updates: CrateMove[];
  /** Locked versions younger than the release age, which a full update would roll back. */
  downgrades: CrateMove[];
}

/** Dirs holding a `Cargo.lock` next to a `Cargo.toml`, honoring `exclude`. */
export async function findCargoDirs(ctx: ModuleContext): Promise<string[]> {
  const locks = await collectFiles(ctx.cwd, CARGO_LOCK_GLOB, ctx.config.exclude);
  const dirs = await Promise.all(
    locks.map(async lock =>
      (await pathExists(join(dirname(lock), 'Cargo.toml'))) ? dirname(lock) : null
    )
  );
  return dirs.filter((dir): dir is string => dir !== null).sort();
}

/** Every `[[package]]` of a `Cargo.lock` body. Line-wise, the format is flat key/value tables. */
export function parseCargoLock(toml: string): LockedCrate[] {
  return toml
    .split(/^\[\[package]]$/m)
    .slice(1)
    .map(block => {
      const field = (key: string) => new RegExp(`^${key} = "([^"]*)"$`, 'm').exec(block)?.[1];
      const source = field('source') ?? '';
      return {
        name: field('name') ?? '',
        version: field('version') ?? '',
        registry: source.startsWith('registry+') || source.startsWith('sparse+'),
        cratesIo:
          source.includes('github.com/rust-lang/crates.io-index') ||
          source.includes('index.crates.io'),
      };
    })
    .filter(crate => crate.name !== '' && crate.version !== '');
}

/** Registry versions per crate name. A crate can be locked in several versions at once. */
function registryVersions(crates: LockedCrate[]): Map<string, string[]> {
  return crates
    .filter(crate => crate.registry)
    .reduce((byName, crate) => {
      byName.set(crate.name, [...(byName.get(crate.name) ?? []), crate.version]);
      return byName;
    }, new Map<string, string[]>());
}

/** Ascending, with anything that's no semver sorted as text. */
function sortVersions(versions: string[]): string[] {
  return [...versions].sort((a, b) =>
    isValid(a) && isValid(b) ? compare(a, b) : a.localeCompare(b)
  );
}

/**
 * The compatibility line cargo keeps a version in, as text: the major from 1.0 on, the minor
 * below it (`0.59`), the patch below 0.1 (`0.0.3`). Anything that's no semver groups with itself.
 */
function compatLine(version: string): string {
  if (!isValid(version)) {
    return version;
  }
  if (getMajor(version) > 0) {
    return String(getMajor(version));
  }
  return getMinor(version) > 0 ? `0.${getMinor(version)}` : `0.0.${getPatch(version)}`;
}

/**
 * Registry crates whose locked version moved between two lockfiles. Versions of one name are
 * paired within their compatibility line, in ascending order: a line that went away while another
 * moved is no move from one to the other (`0.52` dropped and `0.59` bumped is no 0.52 → 0.59). Crates only added or dropped (transitive churn) are left out,
 * like the manifest diff leaves out added dependencies.
 */
export function diffCargoLock(before: string, after: string): Change[] {
  const from = registryVersions(parseCargoLock(before));
  const to = registryVersions(parseCargoLock(after));
  return [...to.entries()].flatMap(([name, afterVersions]) => {
    const beforeVersions = from.get(name) ?? [];
    const removed = sortVersions(beforeVersions.filter(v => !afterVersions.includes(v)));
    const added = sortVersions(afterVersions.filter(v => !beforeVersions.includes(v)));
    const lines = [...new Set(removed.map(compatLine))];
    return lines.flatMap(line => {
      const olds = removed.filter(version => compatLine(version) === line);
      const news = added.filter(version => compatLine(version) === line);
      return olds
        .slice(0, news.length)
        .map((version, index) => ({ name, from: version, to: news[index] ?? version }));
    });
  });
}

const MOVE_RE = /^\s*(Updating|Downgrading)\s+(\S+)\s+v(\S+)\s+->\s+v(\S+)/;

/** The moves of a `cargo update` run, from its log (cargo writes it to stderr). */
export function parseCargoUpdate(output: string): CargoUpdatePlan {
  return output.split('\n').reduce<CargoUpdatePlan>(
    (plan, line) => {
      const [, kind, name, from, to] = MOVE_RE.exec(line) ?? [];
      if (name === undefined || from === undefined || to === undefined) {
        return plan;
      }
      const move = { name, from, to };
      return kind === 'Downgrading'
        ? { ...plan, downgrades: [...plan.downgrades, move] }
        : { ...plan, updates: [...plan.updates, move] };
    },
    { updates: [], downgrades: [] }
  );
}

/** `cargo update`'s log: cargo reports the moves on stderr. */
export function cargoLog(result: ExecResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

/** The cargo version in `cwd`, or null without a cargo. The dir matters: rustup picks the
 * toolchain by it, a `rust-toolchain.toml` next to a crate may pin an older one. */
export async function cargoVersion(run: typeof exec = exec, cwd?: string): Promise<string | null> {
  // a throwing runner (`execOk`) is fine too: no cargo, no version
  const result = await run(['cargo', '--version'], cwd ? { cwd } : {}).catch(() => null);
  return result?.exitCode === 0
    ? (/^cargo (\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null)
    : null;
}

/**
 * Throws unless the host cargo honors `min-publish-age`. An older cargo only warns about the
 * setting and resolves without it, which would let young crates through unnoticed.
 */
export async function assertPublishAgeSupport(
  run: typeof exec = exec,
  cwd?: string
): Promise<void> {
  const version = await cargoVersion(run, cwd);
  if (version === null) {
    throw new Error('cargo not found on PATH: install a Rust toolchain to update crates');
  }
  if (isLessThan(version, PUBLISH_AGE_CARGO)) {
    throw new Error(
      `cargo ${version} ignores the release age, update to ${PUBLISH_AGE_CARGO} or newer (rustup update stable)`
    );
  }
}

/** Full key paths gating crates.io: the global age and the one of the crates.io registry. */
const CRATES_IO_AGE_PATHS = [
  'registry.global-min-publish-age',
  'registries.crates-io.min-publish-age',
];

/** Split `text` on `separator` outside quotes and inline tables or arrays. */
function splitTopLevel(text: string, separator: string): string[] {
  const { parts, current } = [...text].reduce<{
    parts: string[];
    current: string;
    quote: string;
    depth: number;
  }>(
    (state, char) => {
      if (state.quote !== '') {
        return {
          ...state,
          current: state.current + char,
          quote: char === state.quote ? '' : state.quote,
        };
      }
      if (char === '"' || char === "'") {
        return { ...state, current: state.current + char, quote: char };
      }
      const depth =
        state.depth + (char === '{' || char === '[' ? 1 : char === '}' || char === ']' ? -1 : 0);
      return char === separator && state.depth === 0
        ? { ...state, parts: [...state.parts, state.current], current: '' }
        : { ...state, current: state.current + char, depth };
    },
    { parts: [], current: '', quote: '', depth: 0 }
  );
  return [...parts, current];
}

/** A dotted TOML key (`registries."crates-io".min-publish-age`) as plain segments. */
function keyPath(key: string): string[] {
  return splitTopLevel(key, '.').map(part => part.trim().replace(/^(["'])(.*)\1$/, '$2'));
}

/** The full key paths a `key = value` pair sets, an inline table's keys spelled out. */
function assignedPaths(prefix: string[], assignment: string): string[][] {
  const [key = '', ...rest] = splitTopLevel(assignment, '=');
  const path = [...prefix, ...keyPath(key)];
  const value = rest.join('=').trim();
  if (!value.startsWith('{') || !value.endsWith('}')) {
    return [path];
  }
  return splitTopLevel(value.slice(1, -1), ',')
    .filter(entry => entry.includes('='))
    .flatMap(entry => assignedPaths(path, entry));
}

/**
 * Whether a cargo config body sets a publish age for crates.io, in any spelling: a table
 * (`[registry]`, `[registries."crates-io"]`), dotted keys or inline tables
 * (`registry = { global-min-publish-age = "7 days" }`). Line-wise, as cargo's config holds
 * flat scalars and single-line inline tables.
 */
export function setsCratesIoPublishAge(toml: string): boolean {
  return toml
    .split('\n')
    .map(line => (splitTopLevel(line, '#')[0] ?? '').trim())
    .reduce<{ table: string[]; found: boolean }>(
      (state, line) => {
        const header = /^\[\[?(.+?)\]?\]$/.exec(line)?.[1];
        if (header !== undefined) {
          return { ...state, table: keyPath(header) };
        }
        const found =
          line.includes('=') &&
          assignedPaths(state.table, line).some(path =>
            CRATES_IO_AGE_PATHS.includes(path.join('.'))
          );
        return { ...state, found: state.found || found };
      },
      { table: [], found: false }
    ).found;
}

/** The environment counterparts of {@link CRATES_IO_AGE_PATHS}, which win over any config. */
const CRATES_IO_AGE_ENV = [
  'CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE',
  'CARGO_REGISTRIES_CRATES_IO_MIN_PUBLISH_AGE',
];

/**
 * Whether the user sets a crates.io publish age of their own: in the environment, in a cargo
 * config between `dir` and the repo root (cargo reads `.cargo/config(.toml)` from the working dir
 * up) or in `$CARGO_HOME`. Ages for other registries (`[registries.<name>]`) don't count.
 */
async function hasOwnPublishAge(cwd: string, dir: string): Promise<boolean> {
  if (CRATES_IO_AGE_ENV.some(name => process.env[name] !== undefined)) {
    return true;
  }
  const depth = relative(cwd, dir).split(sep).filter(Boolean).length;
  const dirs = Array.from({ length: depth + 1 }, (_, up) =>
    join(dir, ...Array<string>(up).fill('..'), '.cargo')
  );
  const cargoHome = process.env['CARGO_HOME'] ?? join(homedir(), '.cargo');
  const configs = await Promise.all(
    [...dirs, cargoHome].flatMap(base =>
      ['config.toml', 'config'].map(name => readFile(join(base, name), 'utf8').catch(() => ''))
    )
  );
  return configs.some(setsCratesIoPublishAge);
}

/** Output bumper reads: a `[term]` config with colors or `quiet` would hide the moves from it. */
const PLAIN_OUTPUT: Record<string, string> = {
  CARGO_TERM_COLOR: 'never',
  CARGO_TERM_QUIET: 'false',
};

/** The cargo release-age gate for one cargo dir. */
export interface CargoGate {
  /** Environment for cargo: plain output, and bumper's cooldown unless the user sets one. */
  env: Record<string, string>;
  /** Whether any cooldown applies, so cargo has to be new enough to enforce it. */
  gated: boolean;
}

/**
 * bumper's cooldown as cargo's `registry.global-min-publish-age`, so crates clear the same gate
 * as the JavaScript packages. A publish age the repo configures for cargo itself wins.
 */
export async function cargoGate(
  ctx: ModuleContext,
  dir: string,
  policy: ReleaseAgePolicy = ctx.releaseAge
): Promise<CargoGate> {
  if (await hasOwnPublishAge(ctx.cwd, dir)) {
    return { env: PLAIN_OUTPUT, gated: true };
  }
  return policy.seconds > 0
    ? {
        env: {
          ...PLAIN_OUTPUT,
          CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE: `${policy.seconds} seconds`,
        },
        gated: true,
      }
    : { env: PLAIN_OUTPUT, gated: false };
}

/**
 * The crate a cooldown refusal names, from cargo's error (`failed to select a version for the
 * requirement \`name = "^2"\`` … `is too new`), or null for any other failure. It can be a
 * dependency the requested crate pulls in, not the crate itself.
 */
export function tooNewCrate(message: string): string | null {
  return message.includes('is too new')
    ? (/requirement `([^\s=`]+)/.exec(message)?.[1] ?? '')
    : null;
}

/**
 * The requirement a `--precise` version falls outside of, from cargo's error (`failed to select a
 * version for the requirement \`name = "^2.5"\`` … `candidate versions found which didn't
 * match`), or null for any other failure.
 */
export function unmetRequirement(message: string): string | null {
  return message.includes("candidate versions found which didn't match")
    ? (/requirement `([^`]+)`/.exec(message)?.[1] ?? null)
    : null;
}

/** Path of a crate in the crates.io sparse index (`se/rd/serde`, `3/s/syn`, `2/cc`). */
export function sparseIndexPath(crate: string): string {
  const name = crate.toLowerCase();
  switch (name.length) {
    case 1:
      return `1/${name}`;
    case 2:
      return `2/${name}`;
    case 3:
      return `3/${name.slice(0, 1)}/${name}`;
    default:
      return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
  }
}

interface IndexEntry {
  vers: string;
  yanked: boolean;
}

/** Every published, unyanked version of a crates.io crate. */
export async function publishedCrateVersions(
  crate: string,
  run: typeof execOk = execOk
): Promise<string[]> {
  const body = await curlText(`https://index.crates.io/${sparseIndexPath(crate)}`, run);
  return body
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as IndexEntry)
    .filter(entry => !entry.yanked && isValid(entry.vers))
    .map(entry => entry.vers);
}
