import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { findDockerFiles, parseImageRef } from '../../../utils/docker.utils.js';
import { isExcluded, pathExists } from '../../../utils/fs.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import { replaceUnheldLines } from '../../../utils/skip-comment.utils.js';
import type { Pin } from '../../../utils/version-pins.utils.js';
import { realignPlainVersion } from '../../../utils/version-pins.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';
import { ensureNodeLts } from '../../runtimes/node/node-lts.utils.js';
import type { TagFetcher } from '../docker-images/docker-images.feature.js';
import { defaultTagFetcher } from '../docker-images/docker-images.feature.js';

/** The devcontainer node images, current and legacy; their tags carry the node major. */
const NODE_IMAGES = ['devcontainers', 'vscode/devcontainers'].flatMap(path =>
  ['typescript-node', 'javascript-node'].map(name => `mcr.microsoft.com/${path}/${name}`)
);
// `<repo>:1-22-bookworm`: repo, an optional image version, the two-digit node major, a variant
const IMAGE =
  /((?:[\w.-]+\/)*devcontainers\/(?:typescript|javascript)-node):((?:\d+(?:\.\d+)*-)?)([1-9]\d)((?:-[\w.]+)*)(?![\w.])/g;
// the node feature's key, opening its options object
const NODE_FEATURE = /"ghcr\.io\/devcontainers\/features\/node:[^"]*"\s*:\s*\{/;
const VERSION = /("version"\s*:\s*")([^"]*)(")/;

/**
 * The devcontainer configs of the repo: `.devcontainer.json`, `.devcontainer/devcontainer.json`
 * and one level of named configs below it. Fixed paths, read directly.
 */
async function findDevcontainers(ctx: ModuleContext): Promise<string[]> {
  const dir = join(ctx.cwd, '.devcontainer');
  const named = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory())
    .map(entry => join(dir, entry.name, 'devcontainer.json'));
  const candidates = [
    join(ctx.cwd, '.devcontainer.json'),
    join(dir, 'devcontainer.json'),
    ...named,
  ].filter(path => !isExcluded(ctx.cwd, path, ctx.config.exclude));
  const present = await Promise.all(candidates.map(pathExists));
  return candidates.filter((_, index) => present[index]);
}

/** Per line, whether it sits in the node feature's options (`{` on the key's line up to `}`). */
function inNodeFeature(lines: readonly string[]): boolean[] {
  return lines.reduce<{ open: boolean; flags: boolean[] }>(
    ({ open, flags }, line) => {
      const inside = open || NODE_FEATURE.test(line);
      return { open: inside && !line.includes('}'), flags: [...flags, inside] };
    },
    { open: false, flags: [] }
  ).flags;
}

/** Whether `repo:tag` is published; a guessed tag (an old image version, a dropped variant) must
 * never be written. */
export type TagCheck = (repo: string, tag: string) => boolean;

/** The `[repo, tag]` the node images in `text` would move to. */
function imageTargets(text: string, pin: Pin): [string, string][] {
  return [...text.matchAll(IMAGE)].map(
    ([, repo = '', version = '', , variant = '']): [string, string] => [
      repo,
      `${version}${pin.major}${variant}`,
    ]
  );
}

/**
 * Align the node major of the `typescript-node`/`javascript-node` images (to a tag `published`)
 * and the node feature's `version` to the pinned Node, the latter keeping its precision. Aliases
 * (`lts`, `latest`, `none`) and lines below a `// bumper: skip` comment stay.
 */
export function alignDevcontainer(text: string, pin: Pin, published: TagCheck): string {
  const feature = inNodeFeature(text.split('\n'));
  return replaceUnheldLines(text, (line, index) => {
    const imaged = line.replace(
      IMAGE,
      (match, repo: string, version: string, _major: string, variant: string) => {
        const tag = `${version}${pin.major}${variant}`;
        return published(repo, tag) ? `${repo}:${tag}` : match;
      }
    );
    if (!feature[index]) {
      return imaged;
    }
    return imaged.replace(VERSION, (match, open: string, version: string, close: string) => {
      const next = realignPlainVersion(version, pin);
      return next ? `${open}${next}${close}` : match;
    });
  });
}

/** Whether a file references a node image or the node feature. */
const uses = (text: string) => new RegExp(IMAGE.source).test(text) || NODE_FEATURE.test(text);

/** The devcontainer configs and Docker files that may reference a node image or feature. */
async function findTargets(ctx: ModuleContext): Promise<string[]> {
  const [devcontainers, dockerFiles] = await Promise.all([
    findDevcontainers(ctx),
    findDockerFiles(ctx),
  ]);
  return [...devcontainers, ...dockerFiles];
}

/** The feature's alignment, with the registry lookup injectable (see `updateDockerImages`). */
export async function updateDevcontainerNode(
  ctx: ModuleContext,
  fetchTags: TagFetcher = defaultTagFetcher
): Promise<void> {
  const lts = await ensureNodeLts(ctx);
  const files = await findTargets(ctx);
  const texts = await Promise.all(files.map(file => readFile(file, 'utf8')));
  if (ctx.dryRun) {
    files
      .filter((_, index) => uses(texts[index] ?? ''))
      .forEach(file => planLine(`align node → ${lts.major} in ${relative(ctx.cwd, file)}`));
    return;
  }
  // one tag list per repository, fetched only where a move is wanted
  const repos = [...new Set(texts.flatMap(text => imageTargets(text, lts).map(([repo]) => repo)))];
  const tags = new Map(
    await Promise.all(
      repos.map(async (repo): Promise<[string, Set<string>]> => {
        const ref = parseImageRef(`${repo}:latest`);
        return [repo, new Set(ref ? await fetchTags(ref) : [])];
      })
    )
  );
  const published: TagCheck = (repo, tag) => tags.get(repo)?.has(tag) ?? false;
  await Promise.all(
    files.map(async (file, index) => {
      const original = texts[index] ?? '';
      const updated = alignDevcontainer(original, lts, published);
      if (updated !== original) {
        await writeFile(file, updated);
      }
    })
  );
}

export const devcontainerNodeFeature: Module = {
  kind: ModuleKind.Feature,
  id: 'devcontainer-node',
  title: 'Align Node in devcontainer configs',
  async isUsed(ctx) {
    const toggle = ctx.config.modules['devcontainer-node'];
    if (toggle !== undefined) {
      return toggle;
    }
    const texts = await Promise.all((await findTargets(ctx)).map(file => readFile(file, 'utf8')));
    return texts.some(uses);
  },
  async managedImages() {
    // own the node images, so docker-images never bumps them past the LTS
    return NODE_IMAGES;
  },
  update: updateDevcontainerNode,
};
