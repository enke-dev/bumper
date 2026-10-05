import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { ManageSession } from '@enke.dev/bumper-core/manage/session.js';
import { installChannel } from '@enke.dev/bumper-core/utils/channel.js';
import { BOLD, CYAN, DIM, RESET, YELLOW } from '@enke.dev/bumper-core/utils/output.utils.js';

import type { Command, CommandContext } from '../command.types.js';

/** The command line that re-enters this very bumper for the child `update` runs. */
export function selfCommand(): string[] {
  return installChannel() === 'binary'
    ? [process.execPath]
    : [process.execPath, ...(process.argv[1] ? [process.argv[1]] : [])];
}

/** Open `url` in the default browser; best-effort, never throws. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  const [file, ...args] = cmd;
  try {
    spawn(file as string, args, { stdio: 'ignore', detached: true })
      .on('error', () => undefined)
      .unref();
  } catch {
    // no opener available; the URL is printed anyway
  }
}

async function run({ values, positionals }: CommandContext): Promise<void> {
  if (typeof Bun === 'undefined') {
    throw new Error(
      'bumper manage needs the Bun runtime: install the standalone binary ' +
        '(curl -fsSL https://raw.githubusercontent.com/enke-dev/bumper/main/install.sh | sh) ' +
        'or run `bunx --bun @enke.dev/bumper manage`'
    );
  }
  const root = resolve(positionals[0] ?? join(homedir(), 'Projects'));
  const port = values.port !== undefined ? Number(values.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port expects a port number, got "${values.port}"`);
  }
  // loaded lazily: the GUI is a sizeable string and only this command needs it
  // bun-types declares `*.html` as an HTMLBundle (its HTML imports); with `type: text` it is a string
  const { default: html } = (await import('../../../../ui/dist/index.html', {
    with: { type: 'text' },
  })) as unknown as { default: string };
  const { startServer } = await import('./manage.server.js');

  const session = new ManageSession({ root, selfCommand: selfCommand() });
  process.stdout.write(`${DIM}scanning ${root} …${RESET}\n`);
  const workspace = await session.scan();
  const supported = workspace.repos.filter(repo => repo.packageManager !== null).length;
  process.stdout.write(
    `${BOLD}${CYAN}${workspace.repos.length}${RESET} repos (${supported} supported) in ${workspace.stages.length} stage(s)\n`
  );

  const server = startServer({ session, html, token: randomUUID(), port });
  process.stdout.write(`${BOLD}bumper manage${RESET} → ${CYAN}${server.url}${RESET}\n`);
  if (values['no-open'] !== true) {
    openBrowser(server.url);
  }
  process.stdout.write(
    `${DIM}Ctrl+C stops the server (a running update finishes its current step)${RESET}\n`
  );

  await new Promise<void>(done => {
    const stop = (): void => {
      process.stdout.write(`\n${YELLOW}stopping${RESET}\n`);
      void server.close().then(done);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export const manageCommand: Command = {
  name: 'manage',
  run,
  help: () => ({
    usage: ['bumper manage [path] [--port n] [--no-open]'],
    summary: 'Serve the local GUI for cascading updates across the repos under a folder (Bun only)',
    options: [
      '--port n        Listen on a fixed port (default: random free port)',
      '--no-open       Print the URL instead of opening the browser',
    ],
  }),
};
