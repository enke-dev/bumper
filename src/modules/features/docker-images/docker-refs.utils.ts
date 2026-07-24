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

/** An image reference decomposed into its addressable parts. `registry: null` means Docker Hub. */
export interface ImageRef {
  /** Registry host (`ghcr.io`, `myreg:5000`), or null for Docker Hub (the implicit default). */
  registry: string | null;
  /** Namespace/org — `library` for a bare Docker Hub name (`postgres`), `x` for `ghcr.io/x/y`. */
  namespace: string;
  /** Image name (repository leaf), e.g. `postgres`, `app`. */
  name: string;
  /** The tag, or null when the ref pins none (implicit `latest`). */
  tag: string | null;
  /** The `@sha256:…` digest, or null when unpinned. */
  digest: string | null;
}

const DOCKER_HUB_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

/**
 * Decompose an image ref into registry/namespace/name/tag/digest, applying Docker's implicit
 * defaults (a bare name lives under `library` on Docker Hub). The first path segment is treated as
 * a registry host only when it looks like one (contains `.` or `:`, or is `localhost`) — matching
 * docker's own disambiguation. Minimal but covers the Docker Hub + `host/ns/name` shapes; richer
 * grammar (a dedicated parser lib) can slot in later without changing callers.
 */
export function parseImageRef(ref: string): ImageRef {
  const at = ref.indexOf('@');
  const digest = at === -1 ? null : ref.slice(at + 1);
  const withoutDigest = at === -1 ? ref : ref.slice(0, at);

  const segments = withoutDigest.split('/');
  const first = segments[0] ?? '';
  const hasRegistry = segments.length > 1 && (/[.:]/.test(first) || first === 'localhost');
  const registry = hasRegistry ? first : null;
  const path = hasRegistry ? segments.slice(1) : segments;

  const leaf = path[path.length - 1] ?? '';
  const colon = leaf.lastIndexOf(':');
  const name = colon === -1 ? leaf : leaf.slice(0, colon);
  const tag = colon === -1 ? null : leaf.slice(colon + 1);

  const namespaceParts = path.slice(0, -1);
  const namespace =
    namespaceParts.length > 0 ? namespaceParts.join('/') : registry ? '' : 'library';

  return { registry, namespace, name, tag, digest };
}

/** Whether a parsed ref points at Docker Hub (the only registry the v1 client speaks). */
export function isDockerHub(ref: ImageRef): boolean {
  return ref.registry === null || DOCKER_HUB_HOSTS.has(ref.registry);
}
