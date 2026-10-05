import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isValid } from 'verkit';

import type { ModuleContext } from '../context/context.types.js';
import { allDependencies, pathExists, readPackageJson } from './fs.utils.js';
import { publishTimes, viewTool } from './npm-registry.utils.js';
import { planLine, stepNote } from './output.utils.js';
import { isExemptFromReleaseAge, releaseAgeCutoff } from './release-age.utils.js';
import { parseExcludeRule, upsertPnpmExcludeRules } from './release-age-excludes.utils.js';

/** A `--allow-young` package and the versions of it the manifests now pin that are still inside
 * the cooldown — the ones the package manager's install gate would refuse without help. */
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
 * Which `--allow-young` packages ended up on a version the repo's own cooldown would block. Empty
 * without a gate, without allow-young packages, or when every pinned version already cleared it
 * (or is exempt by the repo's own rules) — then nothing needs relaxing.
 */
export async function youngConsumptions(
  ctx: ModuleContext,
  lookup: PublishTimesLookup = publishTimes,
  now: number = Date.now()
): Promise<YoungConsumption[]> {
  const cutoff = releaseAgeCutoff(ctx.releaseAge, now);
  if (cutoff === null || ctx.allowYoung.length === 0) {
    return [];
  }
  const tool = viewTool(ctx.packageManager);
  const consumptions = await Promise.all(
    ctx.allowYoung.map(async name => {
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

/**
 * bun: its excludes are plain names (a permanent exemption), so the gate is lifted for this one
 * install instead — `--frozen-lockfile` keeps the versions afterwards, so later installs of the
 * pushed lockfile aren't affected. Empty when nothing young was consumed.
 */
export async function youngInstallArgs(
  ctx: ModuleContext,
  lookup: PublishTimesLookup = publishTimes,
  now: number = Date.now()
): Promise<string[]> {
  const consumptions = await youngConsumptions(ctx, lookup, now);
  if (consumptions.length === 0) {
    return [];
  }
  const names = consumptions.map(entry => entry.name).join(', ');
  if (ctx.dryRun) {
    planLine(`install with --minimum-release-age 0 (young: ${names})`);
  } else {
    stepNote(`lifting the release-age gate for this install (young: ${names})`);
  }
  return ['--minimum-release-age', '0'];
}
