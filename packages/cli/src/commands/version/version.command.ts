import pkg from '../../../package.json';
import type { Command } from '../command.types.js';

/** Print the bare version — no banner, no decoration, so it stays scriptable. */
function run(): void {
  process.stdout.write(`${pkg.version}\n`);
}

export const versionCommand: Command = {
  name: 'version',
  run,
  help: () => ({
    usage: ['bumper version'],
    summary: 'Print the installed bumper version',
  }),
};
