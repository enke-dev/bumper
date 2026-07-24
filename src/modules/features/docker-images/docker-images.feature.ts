import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { findDockerFiles } from '../../../utils/docker.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { Module } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { parseImageRefs, partitionByOwnership } from './docker-refs.utils.js';

/**
 * Bump base images referenced in Docker/compose files to their newest tag — the docker counterpart
 * of the package-manager bumps. Images owned by another module (see {@link Module.managedImages},
 * e.g. `node` held at LTS by docker-node) are skipped via the ownership carve-out.
 *
 * SKELETON: the ownership partition + file/ref discovery are wired and tested; the registry lookup
 * that resolves each candidate's newest tag is not implemented yet, so `update` currently rewrites
 * nothing. This module is intentionally NOT in the registry until that lands.
 */
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
  async update(ctx) {
    const owned = ctx.managedImages ?? new Set<string>();
    const files = await findDockerFiles(ctx);
    const perFile = await Promise.all(
      files.map(async file => {
        const { candidates } = partitionByOwnership(
          parseImageRefs(await readFile(file, 'utf8')),
          owned
        );
        return { file, candidates };
      })
    );
    perFile.forEach(({ file, candidates }) => {
      const label = relative(ctx.cwd, file);
      candidates.forEach(ref => {
        // TODO: resolve the newest tag for `ref` via the registry client, then rewrite in place.
        if (ctx.dryRun) {
          planLine(`check ${ref} for a newer tag in ${label}`);
        }
      });
    });
  },
};
