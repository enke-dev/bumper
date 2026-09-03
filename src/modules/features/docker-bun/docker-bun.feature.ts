import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { findDockerFiles } from '../../../utils/docker.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { ensureBunLatest } from '../../runtimes/bun/bun-release.utils.js';

const IMAGE_RE = /oven\/bun:[0-9]+(\.[0-9]+)*/g;
const ARG_RE = /BUN_VERSION=[0-9]+(\.[0-9]+)*/g;

/** Docker/compose files that pin a Bun version — an `oven/bun:<ver>` image or a `BUN_VERSION=`
 * arg. Unlike docker-node (which applies to any Docker file), this gates on actual Bun references
 * so a Node repo's Dockerfile doesn't light the module up for nothing. */
async function bunDockerFiles(ctx: ModuleContext): Promise<string[]> {
  const files = await findDockerFiles(ctx);
  const flagged = await Promise.all(
    files.map(async file => {
      const text = await readFile(file, 'utf8');
      return new RegExp(IMAGE_RE.source).test(text) || new RegExp(ARG_RE.source).test(text)
        ? file
        : null;
    })
  );
  return flagged.filter((file): file is string => file !== null);
}

export const dockerBunFeature: Module = {
  kind: ModuleKind.Feature,
  id: 'docker-bun',
  title: 'Align Bun version in Docker/Compose files',
  async isUsed(ctx) {
    const toggle = ctx.config.modules['docker-bun'];
    if (toggle !== undefined) {
      return toggle;
    }
    return (await bunDockerFiles(ctx)).length > 0;
  },
  async managedImages() {
    // Own the `oven/bun` image so it is pinned to the same release as `.bun-version`,
    // `@types/bun` and the packageManager field, rather than to whatever tag the registry lists
    // newest (parallels how docker-node owns `node`).
    return ['oven/bun'];
  },
  async update(ctx) {
    const { version } = await ensureBunLatest(ctx);
    const files = await bunDockerFiles(ctx);
    await Promise.all(
      files.map(async file => {
        const label = relative(ctx.cwd, file);
        if (ctx.dryRun) {
          planLine(`align bun version → ${version} in ${label}`);
          return;
        }
        const original = await readFile(file, 'utf8');
        const updated = original
          .replace(IMAGE_RE, `oven/bun:${version}`)
          .replace(ARG_RE, `BUN_VERSION=${version}`);
        if (updated !== original) {
          await writeFile(file, updated);
        }
      })
    );
  },
};
