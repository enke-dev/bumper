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

/** Map a normalized ref domain to the host serving the OCI API. Docker Hub's canonical `docker.io`
 * is served by `registry-1.docker.io` (`auth.docker.io` issues the tokens). */
export function ociHost(domain: string): string {
  return domain === 'docker.io' ? 'registry-1.docker.io' : domain;
}

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
  if (realm === undefined) {
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

/** Active tags for an OCI repository (`namespace/name`) on `registry`. */
export async function fetchOciTags(
  registry: string,
  repository: string,
  fetchImpl: FetchLike = fetch,
  resolveAuth?: AuthResolver
): Promise<string[]> {
  try {
    const url = `https://${registry}/v2/${repository}/tags/list`;
    const response = await authorizedRequest(url, registry, repository, fetchImpl, resolveAuth);
    if (response === null) {
      return [];
    }
    const body = (await response.json()) as { tags?: string[] };
    return body.tags ?? [];
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
