import { BOLD, CYAN, GREEN, RESET } from '../../utils/output.utils.js';
import { commands } from '../command.registry.js';
import type { Command, CommandContext } from '../command.types.js';

const HEADER = `${BOLD}bumper${RESET} — central, module-based repo updater`;

const GLOBAL_OPTIONS = ['--help, -h     Show this help'];

/** Compose the full help text from every command's partials. */
function render(): string {
  const parts = commands.map(command => command.help());

  const usage = parts.flatMap(part => part.usage);
  const summaries = commands.map(
    command => `  ${GREEN}${command.name.padEnd(8)}${RESET} ${command.help().summary}`
  );
  const options = [...parts.flatMap(part => part.options ?? []), ...GLOBAL_OPTIONS];
  const extras = parts.flatMap(part => part.extra ?? []);

  const sections = [
    HEADER,
    section('Usage', usage),
    section('Commands', summaries, true),
    section('Options', options),
    ...extras.map(extra => section(extra.title, extra.lines)),
  ];

  return `${sections.join('\n\n')}\n`;
}

/** Render a titled section; `preformatted` lines keep their own indentation. */
function section(title: string, lines: string[], preformatted = false): string {
  const body = lines.map(line => (preformatted ? line : `  ${line}`)).join('\n');
  return `${BOLD}${CYAN}${title}${RESET}\n${body}`;
}

function run(_ctx?: CommandContext): void {
  process.stdout.write(render());
}

export const helpCommand: Command = {
  name: 'help',
  run,
  help: () => ({
    usage: [],
    summary: 'Show this help',
  }),
};

/** Direct entry point for CLI dispatch (stream override for stderr on errors). */
export function commandHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(render());
}
