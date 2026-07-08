import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { BumperConfig, RepoConfig } from './config.types.js';
import { ConfigMode } from './config.types.js';

const CONFIG_PATH = join(homedir(), '.bumperrc');

/** Absolute path of the config file. */
export function configPath(): string {
  return CONFIG_PATH;
}

/** Default entry for a freshly discovered repo: fully auto-detected. */
export function defaultRepoConfig(): RepoConfig {
  return { mode: ConfigMode.Auto, exclude: [], modules: {} };
}

/** Fill in any missing fields on a stored entry. */
function normalize(entry: Partial<RepoConfig>): RepoConfig {
  return {
    mode: entry.mode ?? ConfigMode.Auto,
    exclude: entry.exclude ?? [],
    modules: entry.modules ?? {},
  };
}

/** Load `~/.bumperrc`, tolerating an absent or malformed file. */
export async function loadConfig(): Promise<BumperConfig> {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as BumperConfig;
    return { repos: parsed.repos ?? {} };
  } catch {
    return { repos: {} };
  }
}

/** Persist `~/.bumperrc` with stable two-space indent. */
export async function saveConfig(config: BumperConfig): Promise<void> {
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Resolve the config entry for `repoPath`. Unknown paths are auto-detected and
 * persisted with the default (`mode: auto`) entry, so the next run is scoped.
 */
export async function resolveForPath(
  repoPath: string
): Promise<{ config: RepoConfig; created: boolean }> {
  const config = await loadConfig();
  const existing = config.repos[repoPath];
  if (existing) {
    return { config: normalize(existing), created: false };
  }

  const fresh = defaultRepoConfig();
  config.repos[repoPath] = fresh;
  await saveConfig(config);
  return { config: fresh, created: true };
}

/** Update a single repo entry in place and persist. */
export async function setRepoConfig(repoPath: string, entry: RepoConfig): Promise<void> {
  const config = await loadConfig();
  config.repos[repoPath] = entry;
  await saveConfig(config);
}
