import type { ModuleContext, NodeLts } from '../../../context/context.types.js';
import { curlJson } from '../../../utils/npm-registry.utils.js';

interface NodeDistEntry {
  version: string; // e.g. "v22.15.1"
  lts: string | false;
  npm?: string; // npm version bundled with this Node release, e.g. "11.16.0"
}

const DIST_INDEX = 'https://nodejs.org/dist/index.json';

/** Fetch the latest Node LTS from the official dist index (newest-first). The bundled `npm`
 * version travels with it, so the npm `packageManager` field can be aligned to the npm that
 * actually ships with the pinned Node (npm isn't versioned independently of Node). */
export async function fetchLatestLts(): Promise<NodeLts> {
  const entries = await curlJson<NodeDistEntry[]>(DIST_INDEX);
  const latest = entries.find(entry => entry.lts !== false);
  if (!latest) {
    throw new Error('No LTS release found in Node dist index');
  }
  const version = latest.version.replace(/^v/, '');
  const major = Number(version.split('.')[0]);
  return { version, major, ...(latest.npm ? { npm: latest.npm } : {}) };
}

/** Resolve + memoize the latest LTS onto the context. */
export async function ensureNodeLts(ctx: ModuleContext): Promise<NodeLts> {
  ctx.nodeLts ??= await fetchLatestLts();
  return ctx.nodeLts;
}
