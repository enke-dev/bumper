import type { BunRelease, ModuleContext } from '../../../context/context.types.js';
import { latestVersion, viewTool } from '../../../utils/npm-registry.utils.js';

const BUN_PACKAGE = 'bun';

/** Resolve the latest stable Bun release. Bun publishes every release to npm as `bun`, so the
 * same `<tool> view` lookup the dependency bump uses (honoring the repo's `.npmrc`) is the source
 * of truth here — no separate GitHub releases call. */
export async function fetchLatestBun(ctx: ModuleContext): Promise<BunRelease> {
  const version = await latestVersion(BUN_PACKAGE, viewTool(ctx.packageManager), ctx.cwd);
  if (!version) {
    throw new Error('Could not resolve the latest Bun release from the registry');
  }
  return { version, major: Number(version.split('.')[0]) };
}

/** Resolve + memoize the latest Bun release onto the context. */
export async function ensureBunLatest(ctx: ModuleContext): Promise<BunRelease> {
  ctx.bunLatest ??= await fetchLatestBun(ctx);
  return ctx.bunLatest;
}
