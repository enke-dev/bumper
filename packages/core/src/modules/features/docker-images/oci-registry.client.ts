import type { RegistryAuth } from './docker-auth.utils.js';

/** The `fetch` surface these clients need — swapped for a stub in tests. */
export type FetchLike = typeof fetch;

/**
 * Tag lookup for any OCI-compliant registry (Docker Hub, GHCR, Artifactory, self-hosted) via the
 * standard Distribution API `/v2/<repo>/tags/list`, including the `WWW-Authenticate` bearer-token
 * dance. Pure `fetch`, no external client. Best-effort: any failure resolves to `[]`. Injectable
 * for offline tests. `resolveAuth` supplies Basic credentials for the token request when the
 * registry is private (see readDockerConfigAuth); omit for anonymous/public pulls.
 */
export type AuthResolver = (registry: string) => Promise<RegistryAuth | null>;

// Following at most this many `Link: rel=next` pages, so a huge repo can't loop unboundedly.
const MAX_TAG_PAGES = 10;

/** Parse a `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` header into its params. */
function parseChallenge(header: string | null): Record<string, string> {
  const params: Record<string, string> = {};
  if (header !== null) {
    [...header.matchAll(/(\w+)="([^"]*)"/g)].forEach(match => {
      const [, key, value] = match;
      if (key !== undefined && value !== undefined) {
        params[key] = value;
      }
    });
  }
  return params;
}

/** Exchange a bearer challenge for a pull token, sending Basic creds when available. */
async function fetchBearerToken(
  header: string | null,
  repository: string,
  fetchImpl: FetchLike,
  auth: RegistryAuth | null
): Promise<string | null> {
  const challenge = parseChallenge(header);
  const realm = challenge['realm'];
  // The realm is server-controlled; never send Basic credentials to a non-HTTPS token endpoint
  // (a compromised/misconfigured registry could otherwise harvest them in cleartext).
  if (realm === undefined || !realm.startsWith('https://')) {
    return null;
  }
  const params = new URLSearchParams();
  const service = challenge['service'];
  if (service !== undefined) {
    params.set('service', service);
  }
  params.set('scope', challenge['scope'] ?? `repository:${repository}:pull`);
  const headers: Record<string, string> = {};
  if (auth !== null) {
    headers['Authorization'] =
      `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  }
  const response = await fetchImpl(`${realm}?${params.toString()}`, { headers });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as { token?: string; access_token?: string };
  return body.token ?? body.access_token ?? null;
}

/**
 * Issue a request, transparently running the bearer-token dance on a 401 and retrying. Returns the
 * successful response, or null on any auth/registry failure. Shared by the tag + manifest lookups.
 */
async function authorizedRequest(
  url: string,
  registry: string,
  repository: string,
  fetchImpl: FetchLike,
  resolveAuth: AuthResolver | undefined,
  init: RequestInit = {}
): Promise<Response | null> {
  let response = await fetchImpl(url, init);
  if (response.status === 401) {
    const auth = resolveAuth ? await resolveAuth(registry) : null;
    const token = await fetchBearerToken(
      response.headers.get('www-authenticate'),
      repository,
      fetchImpl,
      auth
    );
    if (token === null) {
      return null;
    }
    response = await fetchImpl(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
  }
  return response.ok ? response : null;
}

/** The absolute URL of the `rel=next` page in an OCI `Link` header, or null when there is none. */
function nextPageUrl(header: string | null, registry: string): string | null {
  const match = header?.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
  const target = match?.[1];
  if (target === undefined) {
    return null;
  }
  return target.startsWith('http') ? target : `https://${registry}${target}`;
}

/** Follow `Link: rel=next` pages (bounded), accumulating tag names — registries that paginate
 * `tags/list` would otherwise expose only the first page, hiding the newest tags. */
async function collectTags(
  url: string,
  registry: string,
  repository: string,
  fetchImpl: FetchLike,
  resolveAuth: AuthResolver | undefined,
  depth: number,
  accumulated: string[]
): Promise<string[]> {
  const response = await authorizedRequest(url, registry, repository, fetchImpl, resolveAuth);
  if (response === null) {
    return accumulated;
  }
  const body = (await response.json()) as { tags?: string[] };
  const tags = [...accumulated, ...(body.tags ?? [])];
  const next = nextPageUrl(response.headers.get('link'), registry);
  return next !== null && depth + 1 < MAX_TAG_PAGES
    ? collectTags(next, registry, repository, fetchImpl, resolveAuth, depth + 1, tags)
    : tags;
}

/** Active tags for an OCI repository (`namespace/name`) on `registry`. */
export async function fetchOciTags(
  registry: string,
  repository: string,
  fetchImpl: FetchLike = fetch,
  resolveAuth?: AuthResolver
): Promise<string[]> {
  try {
    const url = `https://${registry}/v2/${repository}/tags/list`;
    return await collectTags(url, registry, repository, fetchImpl, resolveAuth, 0, []);
  } catch {
    return [];
  }
}

// The manifest media types to accept, so multi-arch indexes and single manifests both resolve.
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * The content digest a tag currently resolves to (`sha256:…`), via a `HEAD` on the manifest —
 * used to repin a `repo:tag@sha256:…` ref to the bumped tag's digest. Null when unresolvable, so
 * the caller never writes a stale or guessed digest.
 */
export async function fetchOciDigest(
  registry: string,
  repository: string,
  tag: string,
  fetchImpl: FetchLike = fetch,
  resolveAuth?: AuthResolver
): Promise<string | null> {
  try {
    const url = `https://${registry}/v2/${repository}/manifests/${tag}`;
    const response = await authorizedRequest(url, registry, repository, fetchImpl, resolveAuth, {
      method: 'HEAD',
      headers: { Accept: MANIFEST_ACCEPT },
    });
    return response?.headers.get('docker-content-digest') ?? null;
  } catch {
    return null;
  }
}
