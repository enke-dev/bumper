import { resolve } from 'node:path';

import { loadConfig, resolveForPath, setRepoConfig } from '../../config/config.js';
import type { RepoConfig } from '../../config/config.types.js';
import { ConfigMode } from '../../config/config.types.js';
import type { Command, CommandContext } from '../command.types.js';

async function run({ positionals }: CommandContext): Promise<void> {
  const [sub, repoPath, key, value] = positionals;

  if (sub === 'list' || sub === undefined) {
    const config = await loadConfig();
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  if (sub === 'get') {
    if (!repoPath) {
      throw new Error('config get requires a <path>');
    }
    const { config } = await resolveForPath(resolve(repoPath));
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  if (sub === 'set') {
    if (!repoPath || !key || value === undefined) {
      throw new Error('config set requires <path> <key> <value>');
    }
    const abs = resolve(repoPath);
    const { config } = await resolveForPath(abs);
    const next: RepoConfig = { ...config, modules: { ...config.modules } };

    if (key === 'mode') {
      if (value !== ConfigMode.Auto && value !== ConfigMode.Manual) {
        throw new Error(`mode must be '${ConfigMode.Auto}' or '${ConfigMode.Manual}'`);
      }
      next.mode = value;
    } else if (key === 'exclude') {
      next.exclude = value
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);
    } else if (key.startsWith('modules.')) {
      const id = key.slice('modules.'.length);
      next.modules[id] = value === 'true';
    } else {
      throw new Error(`unknown config key: ${key}`);
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
      'bumper config get <path>',
      'bumper config set <path> <key> <value>',
    ],
    summary: 'Inspect or edit ~/.bumperrc',
    extra: [
      {
        title: 'Config keys (config set)',
        lines: ['mode <auto|manual>      exclude <a,b,c>      modules.<id> <true|false>'],
      },
    ],
  }),
};
