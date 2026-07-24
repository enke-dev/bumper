/**
 * Docker Hub tag lookup via its friendly JSON API (`hub.docker.com/v2/...`), not the OCI registry
 * endpoint — it returns tag names + status in one call with no bearer-token dance for public
 * repos. Pure `fetch`, no external client, so it bundles into a compiled binary cleanly. Injectable
 * for offline tests. Best-effort: any network/registry failure resolves to `[]`, leaving tags
 * unbumped rather than throwing. Endpoint shape informed by VersionLens (ISC).
 */

/** The `fetch` surface this client needs — swapped for a stub in tests. */
export type FetchLike = typeof fetch;

interface HubTag {
  name: string;
  tag_status: string;
}

interface HubTagsPage {
  results?: HubTag[];
  next?: string | null;
}

const MAX_PAGES = 3;
const PAGE_SIZE = 100;

/** Follow the paginated `next` links up to {@link MAX_PAGES}, accumulating active tag names. */
async function collectPages(
  url: string | null,
  fetchImpl: FetchLike,
  depth: number,
  accumulated: string[]
): Promise<string[]> {
  if (url === null || depth >= MAX_PAGES) {
    return accumulated;
  }
  const response = await fetchImpl(url);
  if (!response.ok) {
    return accumulated;
  }
  const page = (await response.json()) as HubTagsPage;
  const names = (page.results ?? [])
    .filter(tag => tag.tag_status === 'active')
    .map(tag => tag.name);
  return collectPages(page.next ?? null, fetchImpl, depth + 1, [...accumulated, ...names]);
}

/** Active tag names for a Docker Hub repository (`namespace/name`), newest-updated first. */
export async function fetchDockerHubTags(
  namespace: string,
  name: string,
  fetchImpl: FetchLike = fetch
): Promise<string[]> {
  const start =
    `https://hub.docker.com/v2/namespaces/${encodeURIComponent(namespace)}` +
    `/repositories/${encodeURIComponent(name)}/tags?page_size=${PAGE_SIZE}&ordering=last_updated`;
  try {
    return await collectPages(start, fetchImpl, 0, []);
  } catch {
    return [];
  }
}
