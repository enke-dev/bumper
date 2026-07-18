import { resolve } from 'node:path';

import { configPath } from '../../config/config.js';
import { buildContext } from '../../context/context.js';
import { detectModules } from '../../modules/module.registry.js';
import { BOLD, CYAN, DIM, GREEN, RESET, YELLOW } from '../../utils/output.utils.js';
import type { Command, CommandContext } from '../command.types.js';

async function run({ values, positionals }: CommandContext): Promise<void> {
  const cwd = resolve(positionals[0] ?? process.cwd());
  const json = values.json ?? false;
  const ignoreConfig = values['ignore-config'] ?? false;
  const { ctx, configCreated } = await buildContext(cwd, { ignoreConfig });
  const modules = await detectModules(ctx);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          cwd: ctx.cwd,
          runtime: ctx.runtime,
          packageManager: ctx.packageManager,
          isMonorepo: ctx.isMonorepo,
          workspaces: ctx.workspaces,
          versionManager: ctx.versionManager,
          config: ctx.config,
          configCreated,
          modules,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const tag = ignoreConfig ? ` ${DIM}(config ignored)${RESET}` : configCreated ? ' (new)' : '';
  process.stdout.write(`${BOLD}${CYAN}${ctx.cwd}${RESET}${tag}\n`);
  const val = (v: string | number | boolean): string => `${GREEN}${v}${RESET}`;
  process.stdout.write(`  runtime         ${val(ctx.runtime)}\n`);
  process.stdout.write(`  packageManager  ${val(ctx.packageManager)}\n`);
  process.stdout.write(
    `  monorepo        ${val(ctx.isMonorepo)} (${ctx.workspaces.length} package(s))\n`
  );
  process.stdout.write(`  versionManager  ${val(ctx.versionManager)}\n`);
  if (ctx.config.exclude.length > 0) {
    const note = ignoreConfig ? '' : ` ${YELLOW}(config)${RESET}`;
    process.stdout.write(`  excludes        ${ctx.config.exclude.join(', ')}${note}\n`);
  }
  process.stdout.write(`\n${BOLD}${CYAN}Modules${RESET}\n`);
  modules.forEach(module => {
    const mark = module.used ? `${GREEN}✓${RESET}` : `${DIM}·${RESET}`;
    const title = module.used ? module.title : `${DIM}${module.title}${RESET}`;
    const forced = module.forced ? ` ${YELLOW}(config: ${module.used ? 'on' : 'off'})${RESET}` : '';
    process.stdout.write(`  ${mark} ${module.id.padEnd(15)} ${title}${forced}\n`);
  });

  // footer: only when config actually drives something this run
  const forcedCount = modules.filter(module => module.forced).length;
  const influences = !ignoreConfig && (forcedCount > 0 || ctx.config.exclude.length > 0);
  if (influences) {
    const parts: string[] = [];
    if (forcedCount > 0) parts.push(`${forcedCount} module toggle(s)`);
    if (ctx.config.exclude.length > 0) parts.push(`${ctx.config.exclude.length} exclude(s)`);
    process.stdout.write(
      `\n${DIM}${parts.join(' + ')} from ${configPath()}.${RESET}\n` +
        `${DIM}Change: bumper config set ${ctx.cwd} <key> <value…>  ·  ` +
        `bypass this run: --ignore-config${RESET}\n`
    );
  }
}

export const detectCommand: Command = {
  name: 'detect',
  run,
  help: () => ({
    usage: ['bumper detect [path] [--json] [--ignore-config]'],
    summary: 'Show resolved context + which modules apply',
    options: [
      '--json          Machine-readable detect output',
      '--ignore-config Ignore ~/.bumperrc; show pure auto-detection',
    ],
  }),
};
