/** Shared shape for every CLI command. */

import type { parseArgs } from 'node:util';

/** Shared parseArgs option config; single source of truth for the value shape. */
export const cliOptions = {
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  only: { type: 'string', multiple: true },
  skip: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  'ignore-config': { type: 'boolean' },
  'skip-update-check': { type: 'boolean' },
  commit: { type: 'boolean', short: 'c' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** Parsed `values` from parseArgs, inferred from {@link cliOptions}. */
export type CommandValues = ReturnType<
  typeof parseArgs<{ options: typeof cliOptions; allowPositionals: true }>
>['values'];

/** Parsed invocation handed to a command's `run`. */
export interface CommandContext {
  values: CommandValues;
  /** Positionals after the command name (command name stripped). */
  positionals: string[];
}

/** A titled block appended after the shared help sections. */
export interface HelpSection {
  title: string;
  lines: string[];
}

/** Command-specific partials merged into the `help` command output. */
export interface CommandHelp {
  /** Lines shown under the shared `Usage` heading. */
  usage: string[];
  /** One-line description shown under the shared `Commands` heading. */
  summary: string;
  /** Lines shown under the shared `Options` heading. */
  options?: string[];
  /** Extra command-specific sections. */
  extra?: HelpSection[];
}

export interface Command {
  /** Name used to dispatch the command (first positional). */
  name: string;
  /** Execute the command with the parsed invocation. */
  run(ctx: CommandContext): Promise<void> | void;
  /** Command-specific help partials. */
  help(): CommandHelp;
}
