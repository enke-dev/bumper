import type { Command } from './command.types.js';
import { configCommand } from './config/config.command.js';
import { detectCommand } from './detect/detect.command.js';
import { helpCommand } from './help/help.command.js';
import { updateCommand } from './update/update.command.js';
import { upgradeCommand } from './upgrade/upgrade.command.js';

/** Every command in display order (help last). */
export const commands: Command[] = [
  detectCommand,
  updateCommand,
  configCommand,
  upgradeCommand,
  helpCommand,
];

export function findCommand(name: string): Command | undefined {
  return commands.find(command => command.name === name);
}
