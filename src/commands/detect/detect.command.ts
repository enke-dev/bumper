import { resolve } from 'node:path';

import { buildContext } from '../../context/context.js';
import { detectModules } from '../../modules/module.registry.js';
import { BOLD, CYAN, DIM, GREEN, RESET } from '../../utils/output.utils.js';
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

  process.stdout.write(`${BOLD}${CYAN}${ctx.cwd}${RESET}${configCreated ? ' (new)' : ''}\n`);
  process.stdout.write(`  runtime         ${ctx.runtime}\n`);
  process.stdout.write(`  packageManager  ${ctx.packageManager}\n`);
  process.stdout.write(
    `  monorepo        ${ctx.isMonorepo} (${ctx.workspaces.length} package(s))\n`
  );
  process.stdout.write(`  versionManager  ${ctx.versionManager}\n`);
  if (ctx.config.exclude.length > 0) {
    process.stdout.write(`  excludes        ${ctx.config.exclude.join(', ')}\n`);
  }
  process.stdout.write(`\n${BOLD}${CYAN}Modules${RESET}\n`);
  modules.forEach(module => {
    const mark = module.used ? `${GREEN}✓${RESET}` : `${DIM}·${RESET}`;
    const title = module.used ? module.title : `${DIM}${module.title}${RESET}`;
    process.stdout.write(`  ${mark} ${module.id.padEnd(15)} ${title}\n`);
  });
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
