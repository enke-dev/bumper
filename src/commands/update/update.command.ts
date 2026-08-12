import { resolve } from 'node:path';

import pkg from '../../../package.json';
import { configPath, loadConfig } from '../../config/config.js';
import { buildContext } from '../../context/context.js';
import { runUpdate } from '../../modules/module.registry.js';
import {
  amendAll,
  collectChangedFiles,
  commitAll,
  isEmptySummary,
  isGitRepo,
  renderCommitBody,
  summarizeChanges,
} from '../../utils/commit.utils.js';
import { approveScripts } from '../../utils/deps.utils.js';
import { runFormat } from '../../utils/format.utils.js';
import { BOLD, CYAN, DIM, GREEN, RESET, YELLOW } from '../../utils/output.utils.js';
import { checkForSelfUpdate, updateHint } from '../../utils/version-check.js';
import type { Command, CommandContext } from '../command.types.js';

const COMMIT_SUBJECT = 'chore: update dependencies';

const APPROVE_CMDS: Partial<Record<string, string[]>> = {
  pnpm: ['pnpm', 'approve-builds', '--all'],
  npm: ['npm', 'approve-scripts', '--all'],
};

/** Stage + commit the run's changes with a grouped markdown summary, or report why it was
 * skipped. Returns true when a commit was created. */
async function commitChanges(cwd: string): Promise<boolean> {
  if (!(await isGitRepo(cwd))) {
    process.stdout.write(`${YELLOW}--commit skipped: ${cwd} is not a git repository${RESET}\n`);
    return false;
  }
  const summary = summarizeChanges(await collectChangedFiles(cwd));
  if (isEmptySummary(summary)) {
    process.stdout.write(`${DIM}Nothing changed — no commit created${RESET}\n`);
    return false;
  }
  await commitAll(cwd, COMMIT_SUBJECT, renderCommitBody(summary));
  process.stdout.write(`${GREEN}✓${RESET} Committed "${COMMIT_SUBJECT}"\n`);
  return true;
}

/** Stage + amend the last commit if the work tree is dirty, otherwise no-op. */
async function amendIfDirty(cwd: string): Promise<void> {
  const changed = await collectChangedFiles(cwd);
  if (changed.length === 0) {
    return;
  }
  await amendAll(cwd);
  process.stdout.write(`${GREEN}✓${RESET} Amended commit\n`);
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

  if (values.format) {
    if (dryRun) {
      process.stdout.write(`${DIM}--format dry-run: ${RESET}`);
    }
    await runFormat(ctx.cwd, ctx.packageManager, dryRun);
    if (values.commit && !dryRun) {
      await amendIfDirty(ctx.cwd);
    }
  }

  if (values.approve) {
    const approveCmd = APPROVE_CMDS[ctx.packageManager] ?? [];
    if (dryRun) {
      process.stdout.write(`${DIM}--approve dry-run: ${RESET}`);
    }
    await approveScripts(ctx, approveCmd);
    if (values.commit && !dryRun) {
      await amendIfDirty(ctx.cwd);
    }
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
      'bumper update [path] [--dry-run] [--commit] [--format] [--approve] [--only id]... [--skip id]... [--exclude path]...',
    ],
    summary: 'Run every applicable module in order',
    options: [
      '--dry-run       Print intended steps without changing anything',
      '--commit, -c    Commit the changes as "chore: update dependencies" with a summary',
      "--format, -f    Run the repo's \"format\" script, or eslint --fix / prettier --write; amends with -c",
      '--approve, -a   Approve install scripts (pnpm/npm); amends with -c',
      '--only id       Module id to run exclusively (repeat for several)',
      '--skip id       Module id to skip (repeat for several)',
      '--exclude, -e path  Repo-relative path skipped this run, not persisted (repeat for several)',
      '--ignore-config Ignore ~/.bumperrc; auto-detect everything, read + write nothing',
      '--skip-update-check  Skip the newer-bumper check for this run',
    ],
  }),
};
