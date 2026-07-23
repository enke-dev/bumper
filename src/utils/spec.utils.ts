import semver from 'semver';

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
 * `>`, or none) *and* the precision the author declared: a major-only spec (`>=20`) stays
 * major-only (`>=22`), a fuller spec (`^20.0.0`, `20.11.0`) takes the full version (`^22.15.1`,
 * `22.15.1`). Keeps an `engines.node` floor aligned to the pinned Node without over-tightening a
 * deliberately loose range. Returns null when the spec isn't a plain operator+version shape — a
 * compound range (`>=18 <21`), `*`, `lts/*`, `latest` — so the caller leaves it untouched.
 */
export function repinNodeSpec(spec: string, version: string, major: number): string | null {
  const match = spec.trim().match(/^(\^|~|>=|>|)(\d+)((?:\.\d+){0,2})$/);
  if (!match) {
    return null;
  }
  const [, operator, , tail] = match;
  // A bare major (empty tail) stays major-granular; any minor/patch means the author wanted a
  // fuller pin, so give them the full resolved version.
  return `${operator}${tail ? version : major}`;
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
