import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { findDockerFiles } from '../../../utils/docker.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { readDockerConfigAuth } from './docker-auth.utils.js';
import { fetchDockerHubTags } from './docker-hub.client.js';
import type { ImageRef } from './docker-refs.utils.js';
import {
  isDockerHub,
  parseImageRef,
  parseImageRefs,
  partitionByOwnership,
} from './docker-refs.utils.js';
import { parseTag, pickNewestTag } from './docker-tags.utils.js';
import { fetchOciTags } from './oci-registry.client.js';

/** Resolve a repository's available tags for a parsed ref. Injected in tests; defaults to the
 * Docker Hub JSON API for Hub images and the OCI Distribution API elsewhere (ghcr/jfrog/…). */
export type TagFetcher = (ref: ImageRef) => Promise<string[]>;

const defaultTagFetcher: TagFetcher = ref =>
  isDockerHub(ref)
    ? fetchDockerHubTags(ref.namespace, ref.name)
    : fetchOciTags(
        ref.registry ?? '',
        ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name,
        fetch,
        readDockerConfigAuth
      );

interface Bump {
  ref: string;
  next: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the newer ref for a candidate, or null to leave it. Requires an explicit numeric tag and
 * no digest pin (digest repinning is a later step); untagged/`latest`, non-numeric tags, and refs
 * whose registry can't be reached are left untouched.
 */
async function resolveBump(ref: string, fetchTags: TagFetcher): Promise<Bump | null> {
  const parsed = parseImageRef(ref);
  if (parsed.tag === null || parsed.digest !== null || parseTag(parsed.tag) === null) {
    return null;
  }
  const newest = pickNewestTag(parsed.tag, await fetchTags(parsed));
  if (newest === null || newest === parsed.tag) {
    return null;
  }
  // the tag sits at the end of the ref (no digest here) → swap just that suffix
  return { ref, next: ref.slice(0, ref.length - parsed.tag.length) + newest };
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
  fetchTags: TagFetcher = defaultTagFetcher
): Promise<void> {
  const owned = ctx.managedImages ?? new Set<string>();
  const files = await findDockerFiles(ctx);
  await Promise.all(
    files.map(async file => {
      const original = await readFile(file, 'utf8');
      const { candidates } = partitionByOwnership(parseImageRefs(original), owned);
      const unique = [...new Set(candidates)];
      const bumps = (await Promise.all(unique.map(ref => resolveBump(ref, fetchTags)))).filter(
        (bump): bump is Bump => bump !== null
      );
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
