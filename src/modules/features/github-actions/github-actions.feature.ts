import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { execOk } from '../../../utils/exec.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import type { Module } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';

/**
 * Whether the repo has any GitHub Actions workflow files. `.github/workflows` is a
 * fixed path, so read it directly rather than globbing — `fs.glob` won't descend
 * dot-directories on Bun (no portable `dot` option), which a glob would need here.
 */
async function hasWorkflows(cwd: string): Promise<boolean> {
  try {
    const entries = await readdir(join(cwd, '.github', 'workflows'));
    return entries.some(name => name.endsWith('.yml') || name.endsWith('.yaml'));
  } catch {
    return false;
  }
}

export const githubActionsFeature: Module = {
  kind: ModuleKind.Feature,
  id: 'github-actions',
  title: 'Pin GitHub Actions to latest versions',
  async isUsed(ctx) {
    return hasWorkflows(ctx.cwd);
  },
  async update(ctx) {
    // actions-up has no stable programmatic API, so it stays the one non-bundled
    // call (invoked through bun's package runner).
    const cmd = ['bunx', 'actions-up', '--yes', '--include-branches'];
    if (ctx.dryRun) {
      planLine(cmd.join(' '));
      return;
    }
    await execOk(cmd, { cwd: ctx.cwd });
  },
};
