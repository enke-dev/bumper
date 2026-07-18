import { resolve } from 'node:path';

import pkg from '../../../package.json';
import { configPath, loadConfig } from '../../config/config.js';
import { buildContext } from '../../context/context.js';
import { runUpdate } from '../../modules/module.registry.js';
import {
  collectChangedFiles,
  commitAll,
  isEmptySummary,
  isGitRepo,
  renderCommitBody,
  summarizeChanges,
} from '../../utils/commit.utils.js';
import { BOLD, CYAN, DIM, GREEN, RESET, YELLOW } from '../../utils/output.utils.js';
import { checkForSelfUpdate, updateHint } from '../../utils/version-check.js';
import type { Command, CommandContext } from '../command.types.js';

const COMMIT_SUBJECT = 'chore: update dependencies';

/** Stage + commit the run's changes with a grouped markdown summary, or report why it was skipped. */
async function commitChanges(cwd: string): Promise<void> {
  if (!(await isGitRepo(cwd))) {
    process.stdout.write(`${YELLOW}--commit skipped: ${cwd} is not a git repository${RESET}\n`);
    return;
  }
  const summary = summarizeChanges(await collectChangedFiles(cwd));
  if (isEmptySummary(summary)) {
    process.stdout.write(`${DIM}Nothing changed — no commit created${RESET}\n`);
    return;
  }
  await commitAll(cwd, COMMIT_SUBJECT, renderCommitBody(summary));
  process.stdout.write(`${GREEN}✓${RESET} Committed "${COMMIT_SUBJECT}"\n`);
}

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
  if (values.commit && !dryRun) {
    await commitChanges(ctx.cwd);
  } else if (values.commit && dryRun) {
    process.stdout.write(`${DIM}--commit ignored under --dry-run (nothing was changed)${RESET}\n`);
  }

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
    usage: [
      'bumper update [path] [--dry-run] [--commit] [--only id]... [--skip id]... [--exclude path]...',
    ],
    summary: 'Run every applicable module in order',
    options: [
      '--dry-run       Print intended steps without changing anything',
      '--commit, -c    Commit the changes as "chore: update dependencies" with a summary',
      '--only id       Module id to run exclusively (repeat for several)',
      '--skip id       Module id to skip (repeat for several)',
      '--exclude, -e path  Repo-relative path skipped this run, not persisted (repeat for several)',
      '--ignore-config Ignore ~/.bumperrc; auto-detect everything, read + write nothing',
      '--skip-update-check  Skip the newer-bumper check for this run',
    ],
  }),
};
