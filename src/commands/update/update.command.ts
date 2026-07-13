import { resolve } from 'node:path';

import { configPath } from '../../config/config.js';
import { buildContext } from '../../context/context.js';
import { runUpdate } from '../../modules/module.registry.js';
import { BOLD, CYAN, DIM, RESET } from '../../utils/output.utils.js';
import type { Command, CommandContext } from '../command.types.js';

async function run({ values, positionals }: CommandContext): Promise<void> {
  const cwd = resolve(positionals[0] ?? process.cwd());
  const dryRun = values['dry-run'] ?? false;
  const exclude = (values.exclude ?? [])
    .flatMap(entry => entry.split(','))
    .map(entry => entry.trim())
    .filter(Boolean);
  const { ctx, configCreated } = await buildContext(cwd, { dryRun, exclude });
  if (configCreated) {
    process.stdout.write(`${DIM}Discovered new repo, wrote entry to ${configPath()}${RESET}\n`);
  }
  process.stdout.write(
    `${BOLD}${CYAN}Updating${RESET} ${ctx.cwd}${dryRun ? `${DIM} (dry run)${RESET}` : ''}\n`
  );
  await runUpdate(ctx, { only: values.only, skip: values.skip });
}

export const updateCommand: Command = {
  name: 'update',
  run,
  help: () => ({
    usage: ['bumper update [path] [--dry-run] [--only id]... [--skip id]... [--exclude path]...'],
    summary: 'Run every applicable module in order',
    options: [
      '--dry-run      Print intended steps without changing anything',
      '--only id      Module id to run exclusively (repeat for several)',
      '--skip id      Module id to skip (repeat for several)',
      '--exclude path Repo-relative path skipped this run, not persisted (repeat or comma-separate)',
    ],
  }),
};
