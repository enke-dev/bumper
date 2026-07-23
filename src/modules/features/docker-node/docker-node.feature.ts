import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';

import type { ModuleContext } from '../../../context/context.types.js';
import { collectFiles } from '../../../utils/fs.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { Module } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { ensureNodeLts } from '../../runtimes/node/node-lts.utils.js';

const DOCKER_GLOB =
  '**/{Dockerfile*,docker-compose*.yaml,docker-compose*.yml,compose*.yaml,compose*.yml}';

/** Locate Docker/compose files, honoring `exclude` and skipping dependency dirs. */
function findDockerFiles(ctx: ModuleContext): Promise<string[]> {
  return collectFiles(ctx.cwd, DOCKER_GLOB, ctx.config.exclude);
}

export const dockerNodeFeature: Module = {
  kind: ModuleKind.Feature,
  id: 'docker-node',
  title: 'Align Node version in Docker/Compose files',
  async isUsed(ctx) {
    const toggle = ctx.config.modules['docker-node'];
    if (toggle !== undefined) {
      return toggle;
    }
    return (await findDockerFiles(ctx)).length > 0;
  },
  async update(ctx) {
    const { version } = await ensureNodeLts(ctx);
    const files = await findDockerFiles(ctx);
    await Promise.all(
      files.map(async file => {
        const label = relative(ctx.cwd, file);
        if (ctx.dryRun) {
          planLine(`align node version → ${version} in ${label}`);
          return;
        }
        const original = await readFile(file, 'utf8');
        const updated = original
          .replace(/node:[0-9]+(\.[0-9]+)*/g, `node:${version}`)
          .replace(/NODE_VERSION=[0-9]+(\.[0-9]+)*/g, `NODE_VERSION=${version}`);
        if (updated !== original) {
          await writeFile(file, updated);
        }
      })
    );
  },
};
