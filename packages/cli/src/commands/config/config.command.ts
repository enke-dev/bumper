import { resolve } from 'node:path';

import { loadConfig, resolveForPath, setRepoConfig } from '@enke.dev/bumper-core/config/config.js';
import {
  applyConfigValue,
  configKeysUsage,
  resolveConfigKey,
} from '@enke.dev/bumper-core/config/config.schema.js';

import type { Command, CommandContext } from '../command.types.js';

async function run({ positionals }: CommandContext): Promise<void> {
  const [sub, ...args] = positionals;

  if (sub === 'list' || sub === undefined) {
    const config = await loadConfig();
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  if (sub === 'get') {
    // path is optional; omit it to inspect the current repo
    const { config } = await resolveForPath(resolve(args[0] ?? process.cwd()));
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  if (sub === 'set') {
    // path is optional and defaults to cwd; a leading config key signals it was omitted. Keys are
    // a closed set (the schema) and never valid repo paths, which is what makes this unambiguous.
    const cwdForm = args[0] !== undefined && resolveConfigKey(args[0]) !== null;
    const abs = resolve(cwdForm ? process.cwd() : (args[0] ?? process.cwd()));
    const [key, ...rest] = cwdForm ? args : args.slice(1);
    if (!key) {
      throw new Error('config set requires [path] <key> <value...>');
    }
    const { config } = await resolveForPath(abs);
    const next = applyConfigValue(config, key, rest);
    await setRepoConfig(abs, next);
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }

  throw new Error(`unknown config subcommand: ${sub}`);
}

export const configCommand: Command = {
  name: 'config',
  run,
  help: () => ({
    usage: [
      'bumper config list',
      'bumper config get [path]',
      'bumper config set [path] <key> <value...>',
    ],
    summary: 'Inspect or edit ~/.bumperrc (path defaults to the current repo)',
    extra: [
      {
        title: 'Config keys (config set)',
        lines: configKeysUsage(),
      },
    ],
  }),
};
