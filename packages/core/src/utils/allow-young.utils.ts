import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isLessThan, isValid } from 'verkit';

import type { ModuleContext } from '../context/context.types.js';
import { exec } from './exec.utils.js';
import { allDependencies, pathExists, readPackageJson } from './fs.utils.js';
import { publishTimes, viewTool } from './npm-registry.utils.js';
import { planLine, stepNote } from './output.utils.js';
import { isExemptFromReleaseAge, releaseAgeCutoff } from './release-age.utils.js';
import { parseExcludeRule, upsertPnpmExcludeRules } from './release-age-excludes.utils.js';

/** A `--allow-young` package (or a pin the bump kept ahead) and the versions of it the manifests
 * now pin that are still inside the cooldown — the ones the package manager's install gate would
 * refuse without help. */
export interface YoungConsumption {
  name: string;
  young: string[];
  /** Publish time per version (epoch ms), for pruning older rules. */
  times: Record<string, number>;
}

export type PublishTimesLookup = (
  pkg: string,
  tool: string,
  cwd: string
) => Promise<Record<string, number>>;

/** Exact versions of `name` pinned anywhere in the workspace manifests (`^`/`~` stripped). */
async function pinnedVersions(ctx: ModuleContext, name: string): Promise<string[]> {
  const manifests = await Promise.all(ctx.workspaces.map(dir => readPackageJson(dir)));
  const versions = manifests
    .map(pkg => (pkg ? allDependencies(pkg)[name] : undefined))
    .filter((spec): spec is string => spec !== undefined)
    .map(spec => spec.replace(/^[\^~]/, ''))
    .filter(version => isValid(version));
  return [...new Set(versions)];
}

/**
 * Which `--allow-young` packages, and which pins the bump kept ahead of their resolved target,
 * are on a version the repo's own cooldown would block. A pin kept ahead is typically one a
 * developer set while it was still young: the bump never walks it back, so the clean install has
 * to accept it. Empty without a gate, without such packages, or when every pinned version already
 * cleared it (or is exempt by the repo's own rules) — then nothing needs relaxing.
 */
export async function youngConsumptions(
  ctx: ModuleContext,
  lookup: PublishTimesLookup = publishTimes,
  now: number = Date.now()
): Promise<YoungConsumption[]> {
  const cutoff = releaseAgeCutoff(ctx.releaseAge, now);
  const names = [...new Set([...ctx.allowYoung, ...(ctx.keptAhead ?? [])])];
  if (cutoff === null || names.length === 0) {
    return [];
  }
  const tool = viewTool(ctx.packageManager);
  const consumptions = await Promise.all(
    names.map(async name => {
      const versions = await pinnedVersions(ctx, name);
      if (versions.length === 0) {
        return null;
      }
      const times = await lookup(name, tool, ctx.cwd);
      const young = versions.filter(version => {
        const at = times[version];
        return (
          at !== undefined && at > cutoff && !isExemptFromReleaseAge(ctx.releaseAge, name, version)
        );
      });
      return young.length > 0 ? { name, young, times } : null;
    })
  );
  return consumptions.filter((entry): entry is YoungConsumption => entry !== null);
}

/**
 * pnpm: persist the young versions as `name@version` rules in `pnpm-workspace.yaml`, merged into
 * an existing union for the same package. Older pinned versions of these packages are pruned once
 * they've cleared the cooldown (they pass the gate on their own by then); versions the registry
 * reports no time for are kept. Rules for other packages are never touched.
 */
export async function recordYoungConsumptions(
  ctx: ModuleContext,
  lookup: PublishTimesLookup = publishTimes,
  now: number = Date.now()
): Promise<void> {
  const consumptions = await youngConsumptions(ctx, lookup, now);
  if (consumptions.length === 0) {
    return;
  }
  const cutoff = releaseAgeCutoff(ctx.releaseAge, now) ?? now;
  const file = join(ctx.cwd, 'pnpm-workspace.yaml');
  const yaml = (await pathExists(file)) ? await readFile(file, 'utf8') : '';
  const existing = new Map(
    ctx.releaseAge.excludes
      .map(parseExcludeRule)
      .filter(rule => rule.versions.length > 0)
      .map(rule => [rule.name, rule.versions] as const)
  );
  const rules = new Map(
    consumptions.map(({ name, young, times }) => {
      const stillYoung = (existing.get(name) ?? []).filter(version => {
        const at = times[version];
        return at === undefined || at > cutoff;
      });
      return [name, [...new Set([...stillYoung, ...young])]];
    })
  );
  const summary = [...rules].map(([name, versions]) => `${name}@${versions.join(' || ')}`);
  if (ctx.dryRun) {
    planLine(
      `pin young versions in pnpm-workspace.yaml minimumReleaseAgeExclude: ${summary.join(', ')}`
    );
    return;
  }
  await writeFile(file, upsertPnpmExcludeRules(yaml, rules));
  stepNote(`pinned young versions in minimumReleaseAgeExclude: ${summary.join(', ')}`);
}

/** The first bun taking `--minimum-release-age-excludes`, which exempts single packages. */
export const BUN_EXCLUDES_FLAG = '1.4.4';

/**
 * Throws unless the bun in `cwd` can exempt single packages on the command line. Without the flag
 * the only way past the cooldown is lifting it for the whole install, which lets every young
 * dependency in along with the pins.
 */
export async function assertBunExcludesSupport(
  cwd: string,
  run: typeof exec = exec
): Promise<void> {
  const result = await run(['bun', '--version'], { cwd }).catch(() => null);
  const version = result?.exitCode === 0 ? result.stdout.trim() : '';
  if (!isValid(version)) {
    throw new Error('bun not found on PATH: install bun to update a bun repo');
  }
  if (isLessThan(version, BUN_EXCLUDES_FLAG)) {
    throw new Error(
      `bun ${version} can't exempt single packages from the release age, update to ${BUN_EXCLUDES_FLAG} or newer (bun upgrade)`
    );
  }
}

/**
 * bun: the young packages are exempted by name for this one install, through
 * `--minimum-release-age-excludes` (bun ≥ 1.4.4); their dependencies stay gated, so an older
 * version that cleared the cooldown is picked where the ranges allow. bunfig's own excludes are
 * permanent, and the flag replaces their list, so the repo's excludes are passed along.
 * `--frozen-lockfile` keeps the versions afterwards. Empty when nothing young was consumed.
 */
export async function youngInstallArgs(
  ctx: ModuleContext,
  lookup: PublishTimesLookup = publishTimes,
  now: number = Date.now(),
  run: typeof exec = exec
): Promise<string[]> {
  const consumptions = await youngConsumptions(ctx, lookup, now);
  if (consumptions.length === 0) {
    return [];
  }
  const young = consumptions.map(entry => entry.name);
  const args = [...new Set([...ctx.releaseAge.excludes, ...young])].flatMap(name => [
    '--minimum-release-age-excludes',
    name,
  ]);
  if (ctx.dryRun) {
    planLine(`install with ${args.join(' ')} (young: ${young.join(', ')})`);
    return args;
  }
  await assertBunExcludesSupport(ctx.cwd, run);
  stepNote(`exempting the young pins from the release age for this install: ${young.join(', ')}`);
  return args;
}
