import type { ImageRef } from '../../../utils/docker.utils.js';
import { parseImageRef, refKey } from '../../../utils/docker.utils.js';

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
