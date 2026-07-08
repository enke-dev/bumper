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
