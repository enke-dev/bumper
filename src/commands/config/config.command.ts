import { resolve } from 'node:path';

import { loadConfig, resolveForPath, setRepoConfig } from '../../config/config.js';
import type { RepoConfig } from '../../config/config.types.js';
import type { Command, CommandContext } from '../command.types.js';

/**
 * The single source of truth for `config set` keys. Both the "was the path omitted?"
 * disambiguation and the value dispatch below read this, so a new key is added in one place —
 * add a case here and its clause in `applyKey` and both stay in sync. Keys are a closed set and
 * never valid repo paths, which is what lets a leading key mean "the path was omitted, use cwd".
 */
type ConfigKey = { field: 'exclude' } | { field: 'module'; id: string };

function parseConfigKey(token: string | undefined): ConfigKey | null {
  if (token === undefined) {
    return null;
  }
  if (token === 'exclude') {
    return { field: 'exclude' };
  }
  if (token.startsWith('modules.')) {
    return { field: 'module', id: token.slice('modules.'.length) };
  }
  return null;
}

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
    // path is optional and defaults to cwd; a leading config key signals it was omitted
    const cwdForm = parseConfigKey(args[0]) !== null;
    const abs = resolve(cwdForm ? process.cwd() : (args[0] ?? process.cwd()));
    const [key, ...rest] = cwdForm ? args : args.slice(1);
    if (!key || rest.length === 0) {
      throw new Error('config set requires [path] <key> <value...>');
    }
    const parsed = parseConfigKey(key);
    if (parsed === null) {
      throw new Error(`unknown config key: ${key}`);
    }
    const { config } = await resolveForPath(abs);
    const next: RepoConfig = { ...config, modules: { ...config.modules } };

    if (parsed.field === 'exclude') {
      next.exclude = rest.map(part => part.trim()).filter(Boolean);
    } else {
      if (rest.length > 1) {
        throw new Error(`modules.${parsed.id} takes a single true|false value`);
      }
      next.modules[parsed.id] = rest[0] === 'true';
    }

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
        lines: ['exclude <path...>      modules.<id> <true|false>'],
      },
    ],
  }),
};
