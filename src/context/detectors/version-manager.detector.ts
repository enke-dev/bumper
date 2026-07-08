import { toolExists } from '../../utils/exec.utils.js';
import { VersionManager } from '../context.types.js';

/**
 * Detect an installed Node version manager. Priority: fnm, asdf, nvm.
 * nvm is a shell function (not on PATH), so it's inferred from `$NVM_DIR`.
 */
export function detectVersionManager(): VersionManager {
  if (toolExists('fnm')) {
    return VersionManager.Fnm;
  }
  if (toolExists('asdf')) {
    return VersionManager.Asdf;
  }
  if (process.env['NVM_DIR']) {
    return VersionManager.Nvm;
  }
  return VersionManager.None;
}
