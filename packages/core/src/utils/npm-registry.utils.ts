import { compareReversed, isLessThanOrEqual, isStable, satisfies } from 'verkit';

import { PackageManager } from '../context/context.types.js';
import { exec, execOk } from './exec.utils.js';
import type { ReleaseAgePolicy } from './release-age.utils.js';
import { isExemptFromReleaseAge, NO_RELEASE_AGE, releaseAgeCutoff } from './release-age.utils.js';

/**
 * Fetch + parse JSON over curl (used for the auth-less Node dist index). `run` defaults to the
 * real `execOk` and is only overridden by tests, so the network call can be driven offline.
 */
export async function curlJson<T>(url: string, run: typeof execOk = execOk): Promise<T> {
  const { stdout } = await run(['curl', '-sSL', '--fail', '--connect-timeout', '20', url]);
  return JSON.parse(stdout) as T;
}

/**
 * The `view`-capable tool for a package manager. pnpm has its own; npm covers
 * npm and bun repos. Both read `.npmrc`, so private registries + auth resolve
 * correctly without us reimplementing them.
 */
export function viewTool(pm: PackageManager): string {
  return pm === PackageManager.Pnpm ? 'pnpm' : 'npm';
}

/**
 * Latest published version of a package via `<tool> view <pkg> version`, run in
 * the repo so its `.npmrc` (scoped registries, auth) applies. Null if
 * unresolvable (network, private without access, 404).
 */
export async function latestVersion(
  pkg: string,
  tool: string,
  cwd: string,
  run: typeof exec = exec
): Promise<string | null> {
  try {
    const { exitCode, stdout } = await run([tool, 'view', pkg, 'version'], { cwd });
    if (exitCode !== 0) {
      return null;
    }
    const version = stdout.trim().split('\n').pop()?.trim();
    return version && /^\d/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * The gate a resolution runs under: the repo's {@link ReleaseAgePolicy} plus the clock it is
 * measured against (`now` is only overridden by tests). Absent — or a policy of `0` seconds —
 * means every published version is eligible and no extra registry call is made.
 */
export interface ReleaseAgeGate {
  policy: ReleaseAgePolicy;
  now?: number;
}

/** The open gate: used whenever a caller resolves without a policy. */
export const NO_GATE: ReleaseAgeGate = { policy: NO_RELEASE_AGE };

/**
 * Publish timestamps per version, via `<tool> view <pkg> time --json`. The registry's `time`
 * map also carries the non-version `created`/`modified` keys, which are dropped here. Empty on
 * any error, which makes every version look untimed — see {@link eligibleVersions}.
 */
export async function publishTimes(
  pkg: string,
  tool: string,
  cwd: string,
  run: typeof exec = exec
): Promise<Record<string, number>> {
  try {
    const { exitCode, stdout } = await run([tool, 'view', pkg, 'time', '--json'], { cwd });
    const trimmed = stdout.trim();
    if (exitCode !== 0 || !trimmed) {
      return {};
    }
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return toStamps(parsed as Record<string, string>);
  } catch {
    return {};
  }
}

/** A registry `time` map as epoch ms, minus its non-version `created`/`modified` keys. */
function toStamps(time: Record<string, string>): Record<string, number> {
  return Object.entries(time).reduce<Record<string, number>>((acc, [version, at]) => {
    const stamp = Date.parse(at);
    if (version !== 'created' && version !== 'modified' && !Number.isNaN(stamp)) {
      acc[version] = stamp;
    }
    return acc;
  }, {});
}

/**
 * The subset of `versions` that already cleared the gate's cooldown. A version the policy exempts
 * passes regardless, and so does one the registry reports no publish time for as long as the
 * policy's `ignoreMissingTime` says so (it mirrors pnpm's setting of the same name, on by default:
 * private registries and mirrors routinely drop the `time` field).
 */
function eligibleVersions(
  versions: readonly string[],
  pkg: string,
  times: Record<string, number>,
  cutoff: number,
  policy: ReleaseAgePolicy
): string[] {
  return versions.filter(version => {
    const at = times[version];
    if (at === undefined) {
      return policy.ignoreMissingTime;
    }
    return at <= cutoff || isExemptFromReleaseAge(policy, pkg, version);
  });
}

/**
 * `candidate` when it already cleared the gate, otherwise the newest *older* stable version that
 * has — so a bump lands on the freshest version the install will actually accept instead of dying
 * on the package manager's own cooldown. Null only when nothing qualifies.
 *
 * The walk-back never rises above `candidate`, so it can't jump to a higher major the dist-tag
 * (or the caller's range, via `accept`) deliberately excluded.
 */
function pickEligible(
  pkg: string,
  candidate: string,
  times: Record<string, number>,
  cutoff: number,
  policy: ReleaseAgePolicy,
  accept: (version: string) => boolean = () => true
): string | null {
  if (eligibleVersions([candidate], pkg, times, cutoff, policy).length > 0) {
    return candidate;
  }
  const older = Object.keys(times).filter(
    version => isStable(version) && isLessThanOrEqual(version, candidate) && accept(version)
  );
  const fallback = eligibleVersions(older, pkg, times, cutoff, policy).sort(compareReversed)[0];
  if (fallback !== undefined) {
    return fallback;
  }
  // nothing cleared the cooldown: a strict gate leaves the dependency where it is, a non-strict
  // one takes the blocked version — which is exactly what pnpm resolves in the same situation.
  return policy.strict ? null : candidate;
}

/** {@link pickEligible}, fetching the publish times first. No registry call without a gate. */
async function clampToEligible(
  pkg: string,
  candidate: string,
  tool: string,
  cwd: string,
  gate: ReleaseAgeGate,
  run: typeof exec,
  accept: (version: string) => boolean = () => true
): Promise<string | null> {
  const cutoff = releaseAgeCutoff(gate.policy, gate.now);
  if (cutoff === null) {
    return candidate;
  }
  const times = await publishTimes(pkg, tool, cwd, run);
  return pickEligible(pkg, candidate, times, cutoff, gate.policy, accept);
}

/**
 * The `latest` dist-tag *and* the full publish-time map in a single `view` call — `npm`/`pnpm`
 * both accept several fields and answer with one `{ version, time }` object. One round-trip, so a
 * gated run costs no more registry calls than an ungated one.
 */
async function latestWithTimes(
  pkg: string,
  tool: string,
  cwd: string,
  run: typeof exec
): Promise<{ version: string | null; times: Record<string, number> }> {
  try {
    const { exitCode, stdout } = await run([tool, 'view', pkg, 'version', 'time', '--json'], {
      cwd,
    });
    const trimmed = stdout.trim();
    if (exitCode !== 0 || !trimmed) {
      return { version: null, times: {} };
    }
    const parsed = JSON.parse(trimmed) as { version?: string; time?: Record<string, string> };
    const version = parsed.version;
    return {
      version: version && /^\d/.test(version) ? version : null,
      times: toStamps(parsed.time ?? {}),
    };
  } catch {
    return { version: null, times: {} };
  }
}

/**
 * {@link latestVersion}, clamped to the newest version the repo's minimum-release-age gate lets
 * through (see {@link ReleaseAgeGate}). Without a gate this is exactly `latestVersion`.
 */
export async function latestEligibleVersion(
  pkg: string,
  tool: string,
  cwd: string,
  gate: ReleaseAgeGate,
  run: typeof exec = exec
): Promise<string | null> {
  const cutoff = releaseAgeCutoff(gate.policy, gate.now);
  if (cutoff === null) {
    return latestVersion(pkg, tool, cwd, run);
  }
  const { version, times } = await latestWithTimes(pkg, tool, cwd, run);
  return version === null ? null : pickEligible(pkg, version, times, cutoff, gate.policy);
}

/**
 * The `peerDependencies` an *exact* package version declares, via `<tool> view '<pkg>@<v>'
 * peerDependencies --json`. Read from the registry (not `node_modules`) so it reflects the
 * version being bumped *to*, not the stale one currently installed. Empty object when the
 * version declares no peers, or on any error/unparseable output. Passing an exact version
 * (not a range) keeps the output a single object rather than a per-version array.
 */
export async function peerDependenciesOf(
  pkg: string,
  version: string,
  tool: string,
  cwd: string,
  run: typeof exec = exec
): Promise<Record<string, string>> {
  try {
    const { exitCode, stdout } = await run(
      [tool, 'view', `${pkg}@${version}`, 'peerDependencies', '--json'],
      { cwd }
    );
    const trimmed = stdout.trim();
    if (exitCode !== 0 || !trimmed) {
      return {};
    }
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Highest published, non-prerelease version of a package satisfying `range`, via
 * `<tool> view '<pkg>@<range>' version`. The tool lists matches ascending — one match
 * prints a bare version, several print `<pkg>@<v> '<v>'` lines — so the last wins.
 * Null if nothing matches (or on error).
 *
 * `gate` clamps the result to the repo's minimum-release-age cooldown, walking back to the newest
 * *in-range* version that already cleared it.
 */
export async function latestVersionInRange(
  pkg: string,
  range: string,
  tool: string,
  cwd: string,
  gate: ReleaseAgeGate = NO_GATE,
  run: typeof exec = exec
): Promise<string | null> {
  try {
    const { exitCode, stdout } = await run([tool, 'view', `${pkg}@${range}`, 'version'], { cwd });
    if (exitCode !== 0) {
      return null;
    }
    const last = stdout.trim().split('\n').pop()?.trim();
    const version = last?.replace(/.*@/, '').replace(/['" ].*/, '');
    if (!version || !/^\d/.test(version)) {
      return null;
    }
    return clampToEligible(pkg, version, tool, cwd, gate, run, candidate =>
      satisfies(candidate, range)
    );
  } catch {
    return null;
  }
}

/**
 * Highest published, non-prerelease version of a package satisfying *every* range in `ranges`
 * (semver AND) — the correct intersection of multiple peer constraints. It fetches the full
 * version list (`<tool> view <pkg> versions --json`) and filters with verkit's `satisfies` per
 * range, because ranges cannot be intersected by string-joining: a peer like `^17 || ^18 || ^19`
 * space-joined with another OR-range produces a *different* range depending on operand order
 * (`A B || C` parses as `A AND B, OR C`), silently allowing versions every peer forbids. Checking
 * each candidate against each range independently is order-independent and honors `||`. Null when
 * nothing satisfies all ranges, `ranges` is empty, or on error.
 */
export async function maxSatisfyingRanges(
  pkg: string,
  ranges: readonly string[],
  tool: string,
  cwd: string,
  gate: ReleaseAgeGate = NO_GATE,
  run: typeof exec = exec
): Promise<string | null> {
  if (ranges.length === 0) {
    return null;
  }
  try {
    const { exitCode, stdout } = await run([tool, 'view', pkg, 'versions', '--json'], { cwd });
    if (exitCode !== 0) {
      return null;
    }
    const trimmed = stdout.trim();
    if (!trimmed) {
      return null;
    }
    const parsed: unknown = JSON.parse(trimmed);
    // A package with a single published version prints a bare string, not an array.
    const versions = Array.isArray(parsed)
      ? (parsed as string[])
      : typeof parsed === 'string'
        ? [parsed]
        : [];
    const matching = versions
      .filter(v => isStable(v))
      .filter(v => ranges.every(range => satisfies(v, range)));
    const cutoff = releaseAgeCutoff(gate.policy, gate.now);
    // the cooldown applies here too: a peer cap that resolves to a just-published version is
    // refused by the same install gate as an unconstrained bump.
    const eligible =
      cutoff === null
        ? matching
        : eligibleVersions(
            matching,
            pkg,
            await publishTimes(pkg, tool, cwd, run),
            cutoff,
            gate.policy
          );
    return eligible.sort(compareReversed)[0] ?? null;
  } catch {
    return null;
  }
}
