import { resolve } from 'node:path';

import pkg from '../../../package.json';
import { configPath, loadConfig } from '../../config/config.js';
import { buildContext } from '../../context/context.js';
import { runUpdate } from '../../modules/module.registry.js';
import { BOLD, CYAN, DIM, RESET, YELLOW } from '../../utils/output.utils.js';
import { checkForSelfUpdate, updateHint } from '../../utils/version-check.js';
import type { Command, CommandContext } from '../command.types.js';

async function run({ values, positionals }: CommandContext): Promise<void> {
  const cwd = resolve(positionals[0] ?? process.cwd());
  const dryRun = values['dry-run'] ?? false;
  const ignoreConfig = values['ignore-config'] ?? false;
  const exclude = (values.exclude ?? []).map(entry => entry.trim()).filter(Boolean);
  const { ctx, configCreated } = await buildContext(cwd, { dryRun, exclude, ignoreConfig });
  if (configCreated) {
    process.stdout.write(`${DIM}Discovered new repo, wrote entry to ${configPath()}${RESET}\n`);
  }
  process.stdout.write(
    `${BOLD}${CYAN}Updating${RESET} ${ctx.cwd}${dryRun ? `${DIM} (dry run)${RESET}` : ''}\n`
  );

  // check for a newer bumper concurrently with the update, so its network latency is absorbed by
  // the module work. --skip-update-check (this run) overrides the global skipVersionCheck (default off).
  const globalSkip = (await loadConfig()).skipVersionCheck ?? false;
  const checkUpdates = !(values['skip-update-check'] ?? false) && !globalSkip;
  const [, latest] = await Promise.all([
    runUpdate(ctx, { only: values.only, skip: values.skip }),
    checkUpdates
      ? checkForSelfUpdate(ctx.packageManager, cwd, pkg.version)
      : Promise.resolve<string | null>(null),
  ]);
  if (latest !== null) {
    process.stdout.write(
      `\n${YELLOW}${updateHint(ctx.packageManager, pkg.version, latest)}${RESET}\n`
    );
  }
}

export const updateCommand: Command = {
  name: 'update',
  run,
  help: () => ({
    usage: ['bumper update [path] [--dry-run] [--only id]... [--skip id]... [--exclude path]...'],
    summary: 'Run every applicable module in order',
    options: [
      '--dry-run       Print intended steps without changing anything',
      '--only id       Module id to run exclusively (repeat for several)',
      '--skip id       Module id to skip (repeat for several)',
      '--exclude path  Repo-relative path skipped this run, not persisted (repeat for several)',
      '--ignore-config Ignore ~/.bumperrc; auto-detect everything, read + write nothing',
      '--skip-update-check  Skip the newer-bumper check for this run',
    ],
  }),
};
