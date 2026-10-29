import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { Runtime } from '../../../context/context.types.js';
import { isExcluded, pathExists, readPackageJson } from '../../../utils/fs.utils.js';
import { planLine } from '../../../utils/output.utils.js';
import { isHeldLine } from '../../../utils/skip-comment.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';

/** A setup action that can read its version from a pin instead of a hand-written input. */
export interface SetupAction {
  /** The pin the action reads, as named in plan lines. */
  pin: string;
  /** Matches the step's `uses:` line. */
  uses: RegExp;
  /** Matches the hand-written version input: indent, value, trailing comment. */
  input: RegExp;
  /** What a hand-written pin looks like; expressions (`${{ matrix.node }}`) and lists stay as
   * written, they are on purpose. */
  literal: RegExp;
  /** The input pointing the action at the pin, or null when the action finds it on its own and
   * the hand-written input is dropped. */
  fileInput: string | null;
  /** Inputs naming where the version comes from; a step setting one is left alone. */
  sourceInputs: readonly string[];
  /** Whether the repo has the pin; `planned` also counts one its runtime module is about to
   * write (detection and dry runs run before it does). */
  isPinned(ctx: ModuleContext, planned: boolean): Promise<boolean>;
}

/** A pin file at the repo root, written by the given runtime's module. */
const pinFile =
  (file: string, runtime: Runtime) =>
  async (ctx: ModuleContext, planned: boolean): Promise<boolean> =>
    (planned && ctx.runtime === runtime) || pathExists(join(ctx.cwd, file));

export const SETUP_ACTIONS: readonly SetupAction[] = [
  {
    pin: '.node-version',
    uses: /^\s*(?:-\s+)?uses:\s*["']?actions\/setup-node\b/,
    input: /^(\s*)node-version:\s*(.*?)\s*(#.*)?$/,
    // `22`, `22.x`, `v22.1.0`, `lts/*`, `lts/iron`, and the `latest`/`node`/`current` aliases
    literal: /^["']?(?:v?\d[\w.*-]*|lts\/[\w*-]+|latest|node|current)["']?$/i,
    fileInput: 'node-version-file',
    sourceInputs: ['node-version-file'],
    isPinned: pinFile('.node-version', Runtime.Node),
  },
  {
    pin: '.bun-version',
    uses: /^\s*(?:-\s+)?uses:\s*["']?oven-sh\/setup-bun\b/,
    input: /^(\s*)bun-version:\s*(.*?)\s*(#.*)?$/,
    // `1.2`, `1.x`, `v1.2.3`, `latest`; `canary` is on purpose and stays
    literal: /^["']?(?:v?\d[\w.*-]*|latest)["']?$/i,
    fileInput: 'bun-version-file',
    sourceInputs: ['bun-version-file'],
    isPinned: pinFile('.bun-version', Runtime.Bun),
  },
  {
    // without a `version`, pnpm/action-setup reads `packageManager`; with both set it fails on
    // any mismatch, which the pnpm self-update makes a matter of time
    pin: 'packageManager',
    uses: /^\s*(?:-\s+)?uses:\s*["']?pnpm\/action-setup\b/,
    input: /^(\s*)version:\s*(.*?)\s*(#.*)?$/,
    literal: /^["']?(?:v?\d[\w.*-]*|latest)["']?$/i,
    fileInput: null,
    // a manifest elsewhere may name no packageManager
    sourceInputs: ['package_json_file'],
    async isPinned(ctx) {
      return (await readPackageJson(ctx.cwd))?.packageManager?.startsWith('pnpm@') ?? false;
    },
  },
];

const STEP_START = /^(\s*)-\s/;
const WITH = /^\s*with:\s*(?:#.*)?$/;
const CHECKOUT = /^\s*(?:-\s+)?uses:\s*["']?actions\/checkout\b/;
const PATH_INPUT = /^\s*path:/;

const indentOf = (line: string) => line.length - line.trimStart().length;

/** The line range `[start, end)` of the step the `uses:` line at `index` belongs to. */
function stepAround(lines: readonly string[], index: number): [number, number] {
  const usesIndent = indentOf(lines[index] ?? '');
  // `uses` is not necessarily the first key of its step: the item marker may sit above it
  const marker = STEP_START.test(lines[index] ?? '')
    ? index
    : lines.findLastIndex(
        (line, i) => i < index && (STEP_START.exec(line)?.[1]?.length ?? Infinity) < usesIndent
      );
  const start = marker === -1 ? index : marker;
  const stepIndent = STEP_START.exec(lines[start] ?? '')?.[1]?.length ?? usesIndent;
  const end = lines.findIndex(
    (line, i) => i > start && line.trim() !== '' && indentOf(line) <= stepIndent
  );
  return [start, end === -1 ? lines.length : end];
}

/**
 * Whether the repo is checked out into the workspace root before the step starting at `start`:
 * a pin file is read from there, so a step ahead of `actions/checkout` (or after one into a
 * `path`) would find none.
 */
function checkedOutBefore(lines: readonly string[], start: number): boolean {
  const stepIndent = indentOf(lines[start] ?? '');
  // the steps list begins below the first line above it indented less, its `steps:` key
  const listStart = lines.findLastIndex(
    (line, i) =>
      i < start &&
      line.trim() !== '' &&
      !line.trimStart().startsWith('#') &&
      indentOf(line) < stepIndent
  );
  return lines.some((line, i) => {
    if (i <= listStart || i >= start || !CHECKOUT.test(line)) {
      return false;
    }
    const [from, to] = stepAround(lines, i);
    return !lines.slice(from, to).some(candidate => PATH_INPUT.test(candidate));
  });
}

/** The `with:` line left without inputs once the dropped lines are gone, so no bare `with:` stays
 * behind. */
function emptiedWith(
  lines: readonly string[],
  [start, end]: [number, number],
  dropped: ReadonlySet<number>
): number[] {
  const at = lines.findIndex((line, i) => i >= start && i < end && WITH.test(line));
  if (at === -1) {
    return [];
  }
  const indent = indentOf(lines[at] ?? '');
  const inputs = lines
    .map((line, i) => ({ line, i }))
    .slice(at + 1, end)
    // a comment is no input
    .filter(({ line }) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  const blockEnd = inputs.findIndex(({ line }) => indentOf(line) <= indent);
  const block = blockEnd === -1 ? inputs : inputs.slice(0, blockEnd);
  return block.every(({ i }) => dropped.has(i)) ? [at] : [];
}

/** The rewrites `[line index, new line or null to drop it]` taking one setup action's
 * hand-written pins over to its pin. */
function rewritesFor(lines: readonly string[], setup: SetupAction): [number, string | null][] {
  return lines.flatMap((line, index) => {
    if (!setup.uses.test(line)) {
      return [];
    }
    const [start, end] = stepAround(lines, index);
    const step = lines.slice(start, end);
    const { fileInput } = setup;
    const sourced = step.some(candidate =>
      setup.sourceInputs.some(input => candidate.trimStart().startsWith(`${input}:`))
    );
    if (sourced || !checkedOutBefore(lines, start)) {
      return [];
    }
    const pins = step.flatMap((candidate, offset): [number, string | null][] => {
      const match = setup.input.exec(candidate);
      if (!match || isHeldLine(lines, start + offset) || !setup.literal.test(match[2] ?? '')) {
        return [];
      }
      const comment = match[3] ? ` ${match[3]}` : '';
      return [
        [start + offset, fileInput ? `${match[1]}${fileInput}: ${setup.pin}${comment}` : null],
      ];
    });
    const dropped = new Set(pins.filter(([, next]) => next === null).map(([i]) => i));
    if (dropped.size === 0) {
      return pins;
    }
    return [
      ...pins,
      ...emptiedWith(lines, [start, end], dropped).map((i): [number, null] => [i, null]),
    ];
  });
}

/**
 * Take every setup action step that pins a literal version over to the pin bumper keeps current:
 * point it at the pin file, or drop the input where the action finds the pin on its own. Steps
 * with an expression, a list or a source input already, steps not preceded by a checkout of the
 * repo, and lines held by a `# bumper: skip` comment, stay.
 */
export function useVersionFiles(text: string, setups = SETUP_ACTIONS): string {
  const lines = text.split('\n');
  const rewrites = new Map(setups.flatMap(setup => rewritesFor(lines, setup)));
  return lines
    .flatMap((line, index) => {
      const next = rewrites.has(index) ? rewrites.get(index) : line;
      return next === null || next === undefined ? [] : [next];
    })
    .join('\n');
}

/** The workflow files of the repo not excluded, with their content. `.github/workflows` is a
 * fixed path. */
async function readWorkflows(ctx: ModuleContext): Promise<{ path: string; text: string }[]> {
  const dir = join(ctx.cwd, '.github', 'workflows');
  const names = await readdir(dir).catch(() => []);
  return Promise.all(
    names
      .filter(name => /\.ya?ml$/.test(name))
      .filter(name => !isExcluded(ctx.cwd, join(dir, name), ctx.config.exclude))
      .map(async name => ({
        path: join(dir, name),
        text: await readFile(join(dir, name), 'utf8'),
      }))
  );
}

/** The setup actions whose pin is there to read (see {@link SetupAction.isPinned}). */
async function pinnedSetups(ctx: ModuleContext, planned: boolean): Promise<SetupAction[]> {
  const pinned = await Promise.all(SETUP_ACTIONS.map(setup => setup.isPinned(ctx, planned)));
  return SETUP_ACTIONS.filter((_, index) => pinned[index]);
}

export const githubVersionFilesFeature: Module = {
  kind: ModuleKind.Feature,
  id: 'github-version-files',
  title: 'Read Node/Bun/pnpm versions from their pins in GitHub workflows',
  async isUsed(ctx) {
    const toggle = ctx.config.modules['github-version-files'];
    if (toggle !== undefined) {
      return toggle;
    }
    // only where a workflow still pins a version by hand that a pin could take over
    const setups = await pinnedSetups(ctx, true);
    return (await readWorkflows(ctx)).some(({ text }) => useVersionFiles(text, setups) !== text);
  },
  async update(ctx) {
    // the pin files are written by the runtimes, which run ahead of this module
    const setups = await pinnedSetups(ctx, ctx.dryRun);
    const workflows = await readWorkflows(ctx);
    await Promise.all(
      workflows.map(async ({ path, text }) => {
        const updated = useVersionFiles(text, setups);
        if (updated === text) {
          return;
        }
        if (ctx.dryRun) {
          const pins = setups
            .filter(setup => useVersionFiles(text, [setup]) !== text)
            .map(setup => setup.pin);
          planLine(`setup actions → ${pins.join(', ')} in ${relative(ctx.cwd, path)}`);
          return;
        }
        await writeFile(path, updated);
      })
    );
  },
};
