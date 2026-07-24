import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { findDockerFiles } from '../../../utils/docker.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { Module } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { ensureNodeLts } from '../../runtimes/node/node-lts.utils.js';

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
  async managedImages() {
    // Own the `node` image so the generic docker feature never bumps it past LTS — this feature
    // holds it at the current LTS instead (parallels how types-node owns `@types/node`).
    return ['node'];
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
