import { coerce, compare } from 'verkit';

/**
 * A version-shaped Docker tag split into its numeric core and variant suffix.
 * `16-alpine` → `{ core: '16', segments: 1, variant: 'alpine' }`.
 */
export interface TagParts {
  /** The dotted numeric portion, e.g. `16`, `16.3`, `16.3.1`. */
  core: string;
  /** How many dot-segments the core has (1 = major-only, 2 = major.minor, 3 = full). */
  segments: number;
  /** The suffix after the numeric core (`alpine`, `bookworm-slim`), or `''` when plain. */
  variant: string;
}

// A tag we're willing to bump: leading `N[.N[.N]]`, optionally `-<variant>`. Anything without a
// numeric core (`latest`, `stable`, `bookworm`) yields null and is left untouched.
const TAG_RE = /^(\d+(?:\.\d+){0,2})(?:-(.+))?$/;

/** Split a tag into numeric core + variant, or null when it has no numeric core. */
export function parseTag(tag: string): TagParts | null {
  const match = TAG_RE.exec(tag.trim());
  if (!match || match[1] === undefined) {
    return null;
  }
  const core = match[1];
  return { core, segments: core.split('.').length, variant: match[2] ?? '' };
}

/**
 * Pick the newest available tag that matches `currentTag`'s shape — same variant suffix and same
 * numeric precision (`16` only races other bare majors, `16.3-alpine` only races `X.Y-alpine`). So
 * a bump preserves how the author pinned it. Returns the winning tag only when it is strictly newer
 * than the current one, else null (nothing to do / current is a non-numeric tag / no match).
 *
 * Comparison is delegated to verkit (`coerce` the core to semver, then `compare`); the split of
 * core vs variant is the docker-specific lexical bit no library owns — the same technique the
 * VersionLens VSCode extension (ISC) uses on node-semver.
 */
export function pickNewestTag(currentTag: string, available: readonly string[]): string | null {
  const current = parseTag(currentTag);
  const currentVersion = current && coerce(current.core);
  if (!current || !currentVersion) {
    return null;
  }
  const newest = available
    .map(tag => ({ tag, parts: parseTag(tag) }))
    .filter(
      (candidate): candidate is { tag: string; parts: TagParts } =>
        candidate.parts !== null &&
        candidate.parts.variant === current.variant &&
        candidate.parts.segments === current.segments
    )
    .map(candidate => ({ tag: candidate.tag, version: coerce(candidate.parts.core) }))
    .filter(
      (candidate): candidate is { tag: string; version: string } => candidate.version !== null
    )
    .sort((a, b) => compare(b.version, a.version))[0];
  return newest && compare(newest.version, currentVersion) > 0 ? newest.tag : null;
}
