import { parseFamiliarName } from '@swimlane/docker-reference';

/**
 * Image-reference handling for Dockerfiles + compose manifests. Extraction (which refs appear in a
 * file) is ours; decomposition of a single ref is delegated to `@swimlane/docker-reference`, a
 * canonical port of docker's own reference grammar — safer than a hand-roll when we rewrite these
 * refs in place. Tag-ordering (the one thing no lib owns) lives in docker-tags.utils.
 */

// `FROM [--platform=…] <ref> [AS stage]` — capture the ref, ignore the optional platform + stage.
const FROM_RE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim;
// compose `image: repo:tag` (optionally quoted).
const IMAGE_RE = /^\s*image:\s*["']?([^\s"']+)["']?/gim;

/** Every base-image reference declared in a Dockerfile or compose file's text. */
export function parseImageRefs(text: string): string[] {
  const refs = [
    ...[...text.matchAll(FROM_RE)].map(match => match[1]),
    ...[...text.matchAll(IMAGE_RE)].map(match => match[1]),
  ].filter((ref): ref is string => ref !== undefined);
  // `FROM scratch` is the empty base image — nothing to bump.
  return refs.filter(ref => ref !== 'scratch');
}

/** An image reference decomposed + normalized to docker's canonical form. */
export interface ImageRef {
  /** Normalized registry host — `docker.io`, `ghcr.io`, `myreg:5000`. Always present. */
  domain: string;
  /** Full repository path including any implicit `library/` — `library/postgres`, `x/y`. */
  repository: string;
  /** The tag, or null when the ref pins none (implicit `latest`). */
  tag: string | null;
  /** The `@sha256:…` digest, or null when unpinned. */
  digest: string | null;
}

/** Decompose + normalize a single ref via docker's canonical grammar, or null if unparseable. */
export function parseImageRef(raw: string): ImageRef | null {
  try {
    const reference = parseFamiliarName(raw.trim());
    if (reference.domain === undefined || reference.repository === undefined) {
      return null;
    }
    return {
      domain: reference.domain,
      repository: reference.repository,
      tag: reference.tag ?? null,
      digest: reference.digest ?? null,
    };
  } catch {
    return null;
  }
}

/** Registry-qualified identity of a ref, for owned-image matching (`docker.io/library/node`). */
function refKey(ref: ImageRef): string {
  return `${ref.domain}/${ref.repository}`;
}

/**
 * Split refs into those an owning module manages (left for it to pin) and the rest the generic
 * docker-images feature may bump. Both the refs and the owned names (`node`, `library/node`,
 * `ghcr.io/x/y`) are normalized through the canonical grammar before comparison, so `node`,
 * `docker.io/library/node`, and a bare `library/node` all match one declaration.
 */
export function partitionByOwnership(
  refs: readonly string[],
  owned: ReadonlySet<string>
): { owned: string[]; candidates: string[] } {
  const ownedKeys = new Set(
    [...owned]
      .map(parseImageRef)
      .filter((ref): ref is ImageRef => ref !== null)
      .map(refKey)
  );
  const result: { owned: string[]; candidates: string[] } = { owned: [], candidates: [] };
  refs.forEach(raw => {
    const parsed = parseImageRef(raw);
    const isOwned = parsed !== null && ownedKeys.has(refKey(parsed));
    result[isOwned ? 'owned' : 'candidates'].push(raw);
  });
  return result;
}
