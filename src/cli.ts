#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { findCommand } from './commands/command.registry.js';
import { cliOptions } from './commands/command.types.js';
import { commandHelp } from './commands/help/help.command.js';

// Node flags `fs.glob` as experimental and prints a warning on every use. We depend
// on it deliberately (the one glob API portable across Node + Bun), so silence just
// that warning — everything else still surfaces. Bun never emits it.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
  const type =
    typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if (type === 'ExperimentalWarning' && String(warning).includes('glob')) {
    return;
  }
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: cliOptions,
  });

  const [name, ...rest] = positionals;
  if (values.help || name === undefined || name === 'help') {
    commandHelp();
    return;
  }

  const command = findCommand(name);
  if (command === undefined) {
    process.stderr.write(`unknown command: ${name}\n\n`);
    commandHelp(process.stderr);
    process.exitCode = 1;
    return;
  }

  await command.run({ values, positionals: rest });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\x1b[31m${message}\x1b[0m\n`);
  process.exitCode = 1;
});
