import { isGreater, isValid } from 'verkit';

import pkg from '../../../package.json';
import { installChannel } from '../../utils/channel.js';
import { BOLD, DIM, GREEN, RESET, YELLOW } from '../../utils/output.utils.js';
import {
  assetName,
  downloadAsset,
  latestReleaseVersion,
  replaceExecutable,
} from '../../utils/self-upgrade.utils.js';
import type { Command } from '../command.types.js';

const INSTALL_SH = 'https://raw.githubusercontent.com/enke-dev/bumper/main/install.sh';

async function run(): Promise<void> {
  const current = pkg.version;

  // A package-manager install is the manager's to upgrade — never self-replace and fight it.
  if (installChannel() === 'managed') {
    process.stdout.write(
      `${YELLOW}bumper ${current} was installed by a package manager — upgrade it there:${RESET}\n` +
        `  ${DIM}npm  i   -g @enke.dev/bumper\n` +
        '  pnpm add -g @enke.dev/bumper\n' +
        `  bun  add -g @enke.dev/bumper${RESET}\n`
    );
    return;
  }

  const latest = await latestReleaseVersion();
  if (latest === null || !isValid(latest)) {
    process.stdout.write(`${YELLOW}couldn't resolve the latest version (offline?)${RESET}\n`);
    return;
  }
  if (!isValid(current) || !isGreater(latest, current)) {
    process.stdout.write(`${GREEN}bumper ${current} is already up to date${RESET}\n`);
    return;
  }

  const asset = assetName({ platform: process.platform, arch: process.arch });
  if (asset === null) {
    process.stdout.write(
      `${YELLOW}no binary published for ${process.platform}/${process.arch}${RESET}\n`
    );
    return;
  }

  process.stdout.write(`${DIM}downloading ${asset} v${latest}…${RESET}\n`);
  const bytes = await downloadAsset(latest, asset);
  if (bytes === null) {
    process.stdout.write(`${YELLOW}download failed for ${asset} v${latest}${RESET}\n`);
    return;
  }

  try {
    await replaceExecutable(process.execPath, bytes);
    process.stdout.write(`${BOLD}${GREEN}upgraded bumper ${current} → ${latest}${RESET}\n`);
  } catch {
    // most likely a non-writable install dir (a root-owned prefix) — fall back to the installer
    process.stdout.write(
      `${YELLOW}couldn't replace ${process.execPath} — re-run the installer instead:${RESET}\n` +
        `  ${DIM}curl -fsSL ${INSTALL_SH} | sh${RESET}\n`
    );
  }
}

export const upgradeCommand: Command = {
  name: 'upgrade',
  run,
  help: () => ({
    usage: ['bumper upgrade'],
    summary: 'Update the bumper binary itself to the latest release',
    extra: [
      {
        title: 'Upgrade',
        lines: [
          'Only for the standalone binary (install.sh). Downloads the latest release for your',
          'platform and replaces the running executable in place. A package-manager install is',
          'left to that manager — the command prints the global-install command instead.',
        ],
      },
    ],
  }),
};
