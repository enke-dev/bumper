import type { RegistryAuth } from './docker-auth.utils.js';
import type { FetchLike } from './docker-hub.client.js';

/**
 * Tag lookup for any OCI-compliant registry (GHCR, Artifactory, self-hosted) via the standard
 * Distribution API `/v2/<repo>/tags/list`, including the `WWW-Authenticate` bearer-token dance.
 * Pure `fetch`, no external client. Best-effort: any failure resolves to `[]`. Injectable for
 * offline tests. `resolveAuth` supplies Basic credentials for the token request when the registry
 * is private (see readDockerConfigAuth); omit for anonymous/public pulls.
 */
export type AuthResolver = (registry: string) => Promise<RegistryAuth | null>;

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

/** Active tags for an OCI repository (`namespace/name`) on `registry`. */
export async function fetchOciTags(
  registry: string,
  repository: string,
  fetchImpl: FetchLike = fetch,
  resolveAuth?: AuthResolver
): Promise<string[]> {
  const url = `https://${registry}/v2/${repository}/tags/list`;
  try {
    let response = await fetchImpl(url);
    if (response.status === 401) {
      const auth = resolveAuth ? await resolveAuth(registry) : null;
      const token = await fetchBearerToken(
        response.headers.get('www-authenticate'),
        repository,
        fetchImpl,
        auth
      );
      if (token === null) {
        return [];
      }
      response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as { tags?: string[] };
    return body.tags ?? [];
  } catch {
    return [];
  }
}
