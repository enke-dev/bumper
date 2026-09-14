import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isValid, satisfies } from 'verkit';

import { PackageManager } from '../context/context.types.js';
import { exec } from './exec.utils.js';

/**
 * A package manager's *minimum release age* gate: it refuses to resolve any version published
 * less than N seconds ago, so a freshly published release is quarantined until the ecosystem
 * (and the advisory databases) had a chance to catch a compromised publish.
 *
 * bumper resolves `latest` straight from the registry, so without knowing the gate it happily
 * rewrites a spec to a version the subsequent install then refuses — the bump dies with
 * `error: Version "x@1.2.3" was published within minimum release age of 86400 seconds`. The gate
 * is the repo's deliberate policy, so the fix is not to disable it but to resolve *within* it:
 * pick the newest version that already cleared the cooldown.
 */
export interface ReleaseAgePolicy {
  /** Cooldown in seconds. `0` means no gate — every version is eligible. */
  seconds: number;
  /** Package patterns exempt from the cooldown (`name`, `@scope/*`, `name@range`). */
  excludes: string[];
  /**
   * What to do when *no* version clears the cooldown: leave the dependency on its current spec
   * (strict) or bump it to the blocked version anyway (non-strict). Mirrors pnpm's
   * `minimumReleaseAgeStrict` — which defaults to `true` for an explicitly configured cooldown and
   * to `false` for pnpm's own built-in one, so a repo that never opted in keeps installing. bun
   * has no such knob and simply errors on a blocked version, so its gate is always strict.
   */
  strict: boolean;
  /**
   * Whether a version the registry reports no publish time for passes the gate. Mirrors pnpm's
   * `minimumReleaseAgeIgnoreMissingTime` (default `true`): private registries and mirrors often
   * drop the `time` field, and blocking on that would freeze every package they serve.
   */
  ignoreMissingTime: boolean;
  /** Where the value came from, for the dry-run/plan line. */
  source: string;
}

/** No gate in force. */
export const NO_RELEASE_AGE: ReleaseAgePolicy = {
  seconds: 0,
  excludes: [],
  strict: true,
  ignoreMissingTime: true,
  source: 'none',
};

/** pnpm ≥11 enforces a 1-day cooldown even when nothing is configured. */
const PNPM_DEFAULT_MINUTES = 1440;

/** Strip a `#`/`;` comment tail and surrounding whitespace from a config line. */
function stripComment(line: string): string {
  return line.replace(/\s+[#;].*$/, '').trim();
}

/** Unquote a scalar, dropping `'`/`"` wrapping and a trailing comma. */
function unquote(value: string): string {
  return value
    .trim()
    .replace(/,$/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

/** The items of an inline (`["a", "b"]`) or already-joined bracketed array. */
function parseInlineArray(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(unquote)
    .filter(Boolean);
}

/**
 * `minimumReleaseAge` + `minimumReleaseAgeExcludes` from a `bunfig.toml` body — the `[install]`
 * table only, so an unrelated `[test]` key of the same name can't be mistaken for it. Parsed
 * line-wise rather than with a TOML dependency: both keys are flat scalars/arrays, and the file
 * must be readable from Node as well as Bun (`Bun.TOML` is runtime-specific).
 */
export function parseBunfig(toml: string): { seconds?: number; excludes: string[] } {
  const result = toml.split('\n').reduce<{
    inInstall: boolean;
    array: string | null;
    seconds?: number;
    excludes: string[];
  }>(
    (state, raw) => {
      const line = stripComment(raw);
      // a multi-line `minimumReleaseAgeExcludes = [` block: collect until the closing bracket
      if (state.array !== null) {
        const next = `${state.array} ${line}`;
        return line.includes(']')
          ? { ...state, array: null, excludes: parseInlineArray(next) }
          : { ...state, array: next };
      }
      if (/^\[.+]$/.test(line)) {
        return { ...state, inInstall: line === '[install]' };
      }
      if (!state.inInstall) {
        return state;
      }
      const age = line.match(/^minimumReleaseAge\s*=\s*(\d+)$/);
      if (age?.[1]) {
        return { ...state, seconds: Number(age[1]) };
      }
      const excludes = line.match(/^minimumReleaseAgeExcludes\s*=\s*(.*)$/);
      if (excludes?.[1] !== undefined) {
        const value = excludes[1].trim();
        return value.includes(']')
          ? { ...state, excludes: parseInlineArray(value) }
          : { ...state, array: value };
      }
      return state;
    },
    { inInstall: false, array: null, excludes: [] }
  );
  return result.seconds === undefined
    ? { excludes: result.excludes }
    : { seconds: result.seconds, excludes: result.excludes };
}

/** The release-age block of a `pnpm-workspace.yaml`, each key absent when not declared. */
export interface PnpmReleaseAgeSettings {
  /** `minimumReleaseAge`, in **minutes** — pnpm's unit. */
  minutes?: number;
  excludes: string[];
  strict?: boolean;
  ignoreMissingTime?: boolean;
}

/**
 * pnpm's release-age settings from a `pnpm-workspace.yaml` body. Parsed line-wise like the
 * `packages:`/`overrides:` blocks elsewhere: top-level scalars plus a flat `- item` list.
 */
export function parsePnpmWorkspace(yaml: string): PnpmReleaseAgeSettings {
  const result = yaml.split('\n').reduce<PnpmReleaseAgeSettings & { inList: boolean }>(
    (state, raw) => {
      const line = stripComment(raw);
      if (line === '') {
        return state;
      }
      const age = line.match(/^minimumReleaseAge:\s*(\d+)$/);
      if (age?.[1]) {
        return { ...state, inList: false, minutes: Number(age[1]) };
      }
      const strict = line.match(/^minimumReleaseAgeStrict:\s*(true|false)$/);
      if (strict?.[1]) {
        return { ...state, inList: false, strict: strict[1] === 'true' };
      }
      const missing = line.match(/^minimumReleaseAgeIgnoreMissingTime:\s*(true|false)$/);
      if (missing?.[1]) {
        return { ...state, inList: false, ignoreMissingTime: missing[1] === 'true' };
      }
      if (/^minimumReleaseAgeExclude:\s*$/.test(line)) {
        return { ...state, inList: true };
      }
      const inline = line.match(/^minimumReleaseAgeExclude:\s*(\[.*])$/);
      if (inline?.[1]) {
        return { ...state, inList: false, excludes: parseInlineArray(inline[1]) };
      }
      if (state.inList && /^\s*-\s+/.test(raw)) {
        state.excludes.push(unquote(line.replace(/^-\s+/, '')));
        return state;
      }
      // any other top-level key ends the list
      return /^\S/.test(raw) ? { ...state, inList: false } : state;
    },
    { inList: false, excludes: [] }
  );
  const { inList: _inList, ...settings } = result;
  return settings;
}

/** `minimum-release-age` / `minimumReleaseAge` (minutes) from an `.npmrc` body — where pnpm read
 * the setting before it moved to `pnpm-workspace.yaml`. */
export function parseNpmrcMinutes(npmrc: string): number | undefined {
  const line = npmrc
    .split('\n')
    .map(stripComment)
    .find(entry => /^minimum[-_]?release[-_]?age\s*=/i.test(entry));
  const value = line?.split('=')[1]?.trim();
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** File body, or an empty string when the file is absent/unreadable. */
async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/** Installed pnpm major, or null when pnpm can't be run. */
async function pnpmMajor(cwd: string, run: typeof exec = exec): Promise<number | null> {
  const { exitCode, stdout } = await run(['pnpm', '--version'], { cwd });
  const major = Number(stdout.trim().split('.')[0]);
  return exitCode === 0 && Number.isInteger(major) ? major : null;
}

/** bun's gate: repo `bunfig.toml` first, then the global `~/.bunfig.toml`. Always strict — bun
 * refuses a blocked version outright, with no fallback to fall back to. */
async function detectBun(cwd: string): Promise<ReleaseAgePolicy> {
  const local = parseBunfig(await readIfPresent(join(cwd, 'bunfig.toml')));
  if (local.seconds !== undefined) {
    return {
      ...NO_RELEASE_AGE,
      seconds: local.seconds,
      excludes: local.excludes,
      source: 'bunfig.toml',
    };
  }
  const global = parseBunfig(await readIfPresent(join(homedir(), '.bunfig.toml')));
  return global.seconds === undefined
    ? NO_RELEASE_AGE
    : {
        ...NO_RELEASE_AGE,
        seconds: global.seconds,
        excludes: global.excludes,
        source: '~/.bunfig.toml',
      };
}

/**
 * pnpm's gate, in minutes: `pnpm-workspace.yaml` first, then `.npmrc` (its pre-11 home). With
 * neither set, pnpm ≥11 still enforces a 1-day cooldown by default — so the installed major
 * decides, and an unresolvable pnpm binary is treated as no gate.
 */
async function detectPnpm(cwd: string, run: typeof exec = exec): Promise<ReleaseAgePolicy> {
  const workspace = parsePnpmWorkspace(await readIfPresent(join(cwd, 'pnpm-workspace.yaml')));
  const shared = {
    excludes: workspace.excludes,
    ignoreMissingTime: workspace.ignoreMissingTime ?? true,
  };
  if (workspace.minutes !== undefined) {
    return {
      ...shared,
      seconds: workspace.minutes * 60,
      // explicitly configured ⇒ strict unless the repo says otherwise
      strict: workspace.strict ?? true,
      source: 'pnpm-workspace.yaml',
    };
  }
  const npmrc = parseNpmrcMinutes(await readIfPresent(join(cwd, '.npmrc')));
  if (npmrc !== undefined) {
    return {
      ...shared,
      seconds: npmrc * 60,
      strict: workspace.strict ?? true,
      source: '.npmrc',
    };
  }
  const major = await pnpmMajor(cwd, run);
  return major !== null && major >= 11
    ? {
        ...shared,
        seconds: PNPM_DEFAULT_MINUTES * 60,
        // pnpm's own built-in cooldown is non-strict: a package with nothing outside the window
        // still installs, so bumping it to the blocked version matches what pnpm would resolve.
        strict: workspace.strict ?? false,
        source: `pnpm ${major} default`,
      }
    : NO_RELEASE_AGE;
}

/**
 * The cooldown the repo's package manager will enforce on the install that follows the bump.
 * `override` (from `--min-release-age`) wins outright, `0` disabling the clamp entirely. npm has
 * no such setting, so npm repos are never gated.
 */
export async function detectReleaseAge(
  cwd: string,
  pm: PackageManager,
  override?: number | undefined,
  run: typeof exec = exec
): Promise<ReleaseAgePolicy> {
  if (override !== undefined) {
    // an explicit cooldown is an explicit policy: strict, like pnpm treats a configured one
    return { ...NO_RELEASE_AGE, seconds: Math.max(0, override), source: '--min-release-age' };
  }
  switch (pm) {
    case PackageManager.Bun:
      return detectBun(cwd);
    case PackageManager.Pnpm:
      return detectPnpm(cwd, run);
    default:
      return NO_RELEASE_AGE;
  }
}

/**
 * Whether `pkg@version` is exempt from the cooldown. Patterns follow what the package managers
 * accept: a bare name, a `@scope/*` glob, or `name@range` (the range narrowing the exemption to
 * matching versions).
 */
export function isExemptFromReleaseAge(
  policy: ReleaseAgePolicy,
  pkg: string,
  version: string
): boolean {
  return policy.excludes.some(entry => {
    const at = entry.lastIndexOf('@');
    const hasRange = at > 0;
    const name = hasRange ? entry.slice(0, at) : entry;
    const range = hasRange ? entry.slice(at + 1) : null;
    const matchesName = name.endsWith('/*')
      ? pkg.startsWith(name.slice(0, -1))
      : name === pkg || name === '*';
    if (!matchesName) {
      return false;
    }
    return range === null || (isValid(version) && satisfies(version, range));
  });
}

/** Newest publish timestamp (epoch ms) a version may carry and still be installable, or null
 * when no gate applies. */
export function releaseAgeCutoff(
  policy: ReleaseAgePolicy,
  now: number = Date.now()
): number | null {
  return policy.seconds > 0 ? now - policy.seconds * 1000 : null;
}
