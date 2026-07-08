import { readFile, writeFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';

import { globFiles } from '../../../utils/fs.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { Module } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { ensureNodeLts } from '../../runtimes/node/node-lts.utils.js';

const DOCKER_GLOB =
  '**/{Dockerfile*,docker-compose*.yaml,docker-compose*.yml,compose*.yaml,compose*.yml}';

/** Locate Docker/compose files, skipping dependency dirs. */
async function findDockerFiles(cwd: string): Promise<string[]> {
  const matches = await globFiles(cwd, DOCKER_GLOB);
  return matches.filter(match => !match.split(sep).includes('node_modules'));
}

export const dockerFeature: Module = {
  kind: ModuleKind.Feature,
  id: 'docker',
  title: 'Align Node version in Docker/Compose files',
  async isUsed(ctx) {
    const toggle = ctx.config.modules['docker'];
    if (toggle !== undefined) {
      return toggle;
    }
    return (await findDockerFiles(ctx.cwd)).length > 0;
  },
  async update(ctx) {
    const { version } = await ensureNodeLts(ctx);
    const files = await findDockerFiles(ctx.cwd);
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
