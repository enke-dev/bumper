import type { ModuleContext } from '../context/context.types.js';
import { collectFiles } from './fs.utils.js';

/** Dockerfiles + compose manifests, matched anywhere in the tree. */
export const DOCKER_GLOB =
  '**/{Dockerfile*,docker-compose*.yaml,docker-compose*.yml,compose*.yaml,compose*.yml}';

/** Locate Docker/compose files, honoring `exclude` and skipping dependency dirs. Shared by the
 * docker-node feature (aligns the Node version) and the docker feature (bumps base images). */
export function findDockerFiles(ctx: ModuleContext): Promise<string[]> {
  return collectFiles(ctx.cwd, DOCKER_GLOB, ctx.config.exclude);
}
