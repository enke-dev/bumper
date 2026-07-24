import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { findDockerFiles } from '../../../utils/docker.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { readDockerConfigAuth } from './docker-auth.utils.js';
import type { ImageRef } from './docker-refs.utils.js';
import { parseImageRef, parseImageRefs, partitionByOwnership } from './docker-refs.utils.js';
import { parseTag, pickNewestTag } from './docker-tags.utils.js';
import { fetchOciDigest, fetchOciTags, ociHost } from './oci-registry.client.js';

/** Resolve a repository's available tags for a parsed ref. Injected in tests; defaults to the OCI
 * Distribution API for every registry (Docker Hub included, via `registry-1.docker.io`). */
export type TagFetcher = (ref: ImageRef) => Promise<string[]>;

/** Resolve the content digest a tag currently points at — used to repin a digest-pinned ref. */
export type DigestResolver = (ref: ImageRef, tag: string) => Promise<string | null>;

const defaultTagFetcher: TagFetcher = ref =>
  fetchOciTags(ociHost(ref.domain), ref.repository, fetch, readDockerConfigAuth);

const defaultDigestResolver: DigestResolver = (ref, tag) =>
  fetchOciDigest(ociHost(ref.domain), ref.repository, tag, fetch, readDockerConfigAuth);

interface Bump {
  ref: string;
  next: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the newer ref for a candidate, or null to leave it. Requires an explicit numeric tag;
 * untagged/`latest` and non-numeric tags are left untouched. A `repo:tag@sha256:…` ref is repinned
 * — the tag bumps AND the digest is re-resolved to that new tag (skipped if the digest can't be
 * resolved, so we never write a stale/guessed one). A bare `repo@sha256:…` with no tag has no
 * version anchor and is left as-is.
 */
async function resolveBump(
  ref: string,
  fetchTags: TagFetcher,
  resolveDigest: DigestResolver
): Promise<Bump | null> {
  const parsed = parseImageRef(ref);
  if (!parsed || parsed.tag === null || parseTag(parsed.tag) === null) {
    return null;
  }
  const newest = pickNewestTag(parsed.tag, await fetchTags(parsed));
  if (newest === null || newest === parsed.tag) {
    return null;
  }
  if (parsed.digest === null) {
    // tag-only: the tag sits at the end of the ref → swap just that suffix
    return { ref, next: ref.slice(0, ref.length - parsed.tag.length) + newest };
  }
  const digest = await resolveDigest(parsed, newest);
  if (digest === null) {
    return null;
  }
  // `repo:tag@sha256:…` → bump the tag (before the `@`) and repin the digest after it
  const beforeDigest = ref.slice(0, ref.lastIndexOf('@'));
  const withNewTag = beforeDigest.slice(0, beforeDigest.length - parsed.tag.length) + newest;
  return { ref, next: `${withNewTag}@${digest}` };
}

/** Apply each bump to the file text, matching the ref as a whole token (never a substring of a
 * longer ref like `mynode:16` or `postgres:16-alpine`). */
function applyBumps(text: string, bumps: readonly Bump[]): string {
  return bumps.reduce((acc, { ref, next }) => {
    const token = new RegExp(`(?<![\\w./@-])${escapeRegExp(ref)}(?![\\w.-])`, 'g');
    return acc.replace(token, next);
  }, text);
}

/**
 * Bump base images referenced in Docker/compose files to their newest tag on the same variant +
 * precision (see {@link pickNewestTag}). Images owned by another module (see
 * {@link Module.managedImages}, e.g. `node` held at LTS by docker-node) are skipped via the
 * ownership carve-out. Best-effort per image: a registry failure leaves that ref untouched.
 */
export async function updateDockerImages(
  ctx: ModuleContext,
  fetchTags: TagFetcher = defaultTagFetcher,
  resolveDigest: DigestResolver = defaultDigestResolver
): Promise<void> {
  const owned = ctx.managedImages ?? new Set<string>();
  const files = await findDockerFiles(ctx);
  await Promise.all(
    files.map(async file => {
      const original = await readFile(file, 'utf8');
      const { candidates } = partitionByOwnership(parseImageRefs(original), owned);
      const unique = [...new Set(candidates)];
      const bumps = (
        await Promise.all(unique.map(ref => resolveBump(ref, fetchTags, resolveDigest)))
      ).filter((bump): bump is Bump => bump !== null);
      if (bumps.length === 0) {
        return;
      }
      const label = relative(ctx.cwd, file);
      if (ctx.dryRun) {
        bumps.forEach(({ ref, next }) => planLine(`bump ${ref} → ${next} in ${label}`));
        return;
      }
      const updated = applyBumps(original, bumps);
      if (updated !== original) {
        await writeFile(file, updated);
      }
    })
  );
}

export const dockerImagesFeature: Module = {
  kind: ModuleKind.Feature,
  id: 'docker-images',
  title: 'Update Docker base images to latest tags',
  async isUsed(ctx) {
    const toggle = ctx.config.modules['docker-images'];
    if (toggle !== undefined) {
      return toggle;
    }
    return (await findDockerFiles(ctx)).length > 0;
  },
  update: ctx => updateDockerImages(ctx),
};
