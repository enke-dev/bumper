import semver from 'semver';
import { parseRange } from 'semver-utils';

/** A version segment that is present and purely numeric (an absent segment counts as fine). */
function numericSegment(segment: string | undefined): boolean {
  return segment === undefined || /^\d+$/.test(segment);
}

/**
 * Whether a spec is a concrete, pinnable version: a full `x.y.z` semver (incl. prerelease
 * and build metadata), optionally prefixed by `^` or `~`. Anything else — ranges (`>=x <y`),
 * wildcards/partials (`1.x`, `1.2`, `1`), `workspace:`, `catalog:`, `link:`, `npm:` aliases,
 * git/url, `*`, `latest` — is left untouched.
 */
export function isPinnable(spec: string): boolean {
  return semver.valid(spec.replace(/^[\^~]/, '')) !== null;
}

/** Leading range operator of a spec (`^`, `~`, or `''`). */
export function operatorOf(spec: string): string {
  return spec.startsWith('^') ? '^' : spec.startsWith('~') ? '~' : '';
}

/**
 * Realign a single-version spec to a new release, preserving both the operator (`^`, `~`, `>=`,
 * `>`, `=`, or none) *and* the precision the author declared: a major-only spec (`>=20`) stays
 * major-only (`>=22`), a fuller spec (`^20.0.0`, `20.11.0`) takes the full version (`^22.15.1`,
 * `22.15.1`). Keeps an `engines.node` floor aligned to the pinned Node without over-tightening a
 * deliberately loose range. Returns null when the spec isn't a plain operator+version pin — a
 * compound range (`>=18 <21`), an `||` union, a wildcard (`20.x`, `*`), `lts/*`, `latest`, empty —
 * so the caller leaves it untouched.
 *
 * `semver-utils` owns the parse (operator + precision detection); we emit the string ourselves
 * because its `stringifyRange` inserts spaces and forces a full `x.y.z`. `major` is the LTS major
 * used when the spec is major-granular; `version` supplies the minor/patch for fuller specs.
 */
export function realignVersionSpec(spec: string, version: string, major: number): string | null {
  const trimmed = spec.trim();
  // Wildcards parse inconsistently (`20.x` keeps the `x`, `20.X` silently drops it) — bail on any.
  if (/[xX*]/.test(trimmed)) {
    return null;
  }
  const parts = parseRange(trimmed);
  const part = parts[0];
  // Exactly one plain comparator with a numeric major; anything else is a shape we don't rewrite.
  if (parts.length !== 1 || part === undefined || part.operator === '||') {
    return null;
  }
  const { operator, major: pMajor, minor, patch } = part;
  if (
    pMajor === undefined ||
    !numericSegment(pMajor) ||
    !numericSegment(minor) ||
    !numericSegment(patch)
  ) {
    return null;
  }
  const [nextMajor, nextMinor, nextPatch] = version.split('.');
  // Major-only (no minor) stays major-granular; a declared minor/patch takes the resolved version.
  return (
    `${operator ?? ''}${minor === undefined ? major : nextMajor}` +
    (minor !== undefined ? `.${nextMinor}` : '') +
    (patch !== undefined ? `.${nextPatch}` : '')
  );
}

/**
 * Whether a spec is a multi-version compatibility range (e.g. `>=4.8.4 <6.1.0`, `4 || 5`) —
 * as opposed to a pinnable version or a protocol/tag spec. Used to cap a concrete bump to a
 * range the same manifest declares for the package (typically an optional peer).
 */
export function isVersionRange(spec: string): boolean {
  if (isPinnable(spec)) {
    return false;
  }
  return /[<>]/.test(spec) || spec.includes('||') || /\d\s+[\d<>=~^v]/.test(spec.trim());
}
