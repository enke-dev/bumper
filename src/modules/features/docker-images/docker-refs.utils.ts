/**
 * Minimal image-reference extraction for Dockerfiles + compose manifests. Deliberately small for
 * the ownership skeleton — full ref normalization (implicit `docker.io`/`library/`) can move to a
 * dedicated parser later. Technique for the tag side is informed by VersionLens (ISC).
 */

// `FROM [--platform=…] <ref> [AS stage]` — capture the ref, ignore the optional platform + stage.
const FROM_RE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim;
// compose `image: repo:tag` (optionally quoted).
const IMAGE_RE = /^\s*image:\s*["']?([^\s"']+)["']?/gim;

/** Every base-image reference declared in a Dockerfile or compose file's text. */
export function parseImageRefs(text: string): string[] {
  const refs = [
    ...[...text.matchAll(FROM_RE)].map(m => m[1]),
    ...[...text.matchAll(IMAGE_RE)].map(m => m[1]),
  ].filter((ref): ref is string => ref !== undefined);
  // `FROM scratch` is the empty base image — nothing to bump.
  return refs.filter(ref => ref !== 'scratch');
}

/**
 * The repository part of an image ref — the ref stripped of its `:tag` and `@digest`, keeping any
 * registry/namespace prefix. `node:22` → `node`, `ghcr.io/x/app:1.2` → `ghcr.io/x/app`. Used to
 * match a ref against a module's {@link Module.managedImages} declaration.
 */
export function imageRepo(ref: string): string {
  const withoutDigest = ref.split('@')[0] ?? ref;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastSegment = withoutDigest.slice(lastSlash + 1);
  const colon = lastSegment.indexOf(':');
  const name = colon === -1 ? lastSegment : lastSegment.slice(0, colon);
  return (lastSlash === -1 ? '' : withoutDigest.slice(0, lastSlash + 1)) + name;
}

/**
 * Split refs into those an owning module manages (left for it to pin) and the rest the generic
 * docker feature may bump. This is the ownership carve-out: `docker-node` declares `node`, so a
 * `FROM node:…` lands in `owned` and never gets chased past LTS.
 */
export function partitionByOwnership(
  refs: readonly string[],
  owned: ReadonlySet<string>
): { owned: string[]; candidates: string[] } {
  const result: { owned: string[]; candidates: string[] } = { owned: [], candidates: [] };
  refs.forEach(ref => result[owned.has(imageRepo(ref)) ? 'owned' : 'candidates'].push(ref));
  return result;
}
