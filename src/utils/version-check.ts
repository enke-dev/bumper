import { isGreater, isValid } from 'verkit';

import { PackageManager } from '../context/context.types.js';
import type { InstallChannel } from './channel.js';
import { installChannel } from './channel.js';
import { exec } from './exec.utils.js';
import { latestVersion, viewTool } from './npm-registry.utils.js';

/** The published package to check against — bumper itself. */
const SELF = '@enke.dev/bumper';

/** Global-install command per package manager, for the update hint. */
const INSTALL_CMD: Record<PackageManager, string> = {
  [PackageManager.Bun]: 'bun add -g',
  [PackageManager.Pnpm]: 'pnpm add -g',
  [PackageManager.Npm]: 'npm i -g',
};

/**
 * Kick off a self-version lookup, meant to run *concurrently* with the update so its latency
 * hides behind the module work. Resolves to the newer published version when `current` is behind
 * it, or `null` — up to date or unresolvable (offline / private / 404). Never throws; whether to
 * call it at all (flag / config gate) is the caller's decision. The caller awaits it after the
 * update and, if non-null, prints {@link updateHint}.
 */
export function checkForSelfUpdate(
  pm: PackageManager,
  cwd: string,
  current: string,
  run: typeof exec = exec
): Promise<string | null> {
  return latestVersion(SELF, viewTool(pm), cwd, run).then(latest =>
    latest && isValid(latest) && isValid(current) && isGreater(latest, current) ? latest : null
  );
}

/**
 * One-line hint text for an available update (no ANSI; the caller styles it). A binary install
 * upgrades itself (`bumper upgrade`); a package-manager install is upgraded through that manager,
 * so point at its global-install command.
 */
export function updateHint(
  pm: PackageManager,
  current: string,
  latest: string,
  channel: InstallChannel = installChannel()
): string {
  const how = channel === 'binary' ? 'run: bumper upgrade' : `${INSTALL_CMD[pm]} ${SELF}`;
  return `bumper ${current} is out of date — ${latest} available: ${how}`;
}
