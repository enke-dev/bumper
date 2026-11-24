import { relative } from 'node:path';

import {
  assertPublishAgeSupport,
  cargoGate,
  cargoLog,
  findCargoDirs,
  parseCargoUpdate,
  tooNewCrate,
} from '../../../utils/cargo.utils.js';
import { execOk } from '../../../utils/exec.utils.js';
import { planLine, stepNote } from '../../../utils/output.utils.js';
import type { Module, ModuleContext } from '../../module.types.js';
import { ModuleKind } from '../../module.types.js';

/**
 * Refresh one cargo dir's lockfile within the ranges of its `Cargo.toml`s and the release age.
 *
 * A plain `cargo update` under `min-publish-age` rolls back every locked version younger than the
 * gate, a crate a developer or the tauri feature locked on purpose. So the full update only runs
 * as a dry run, and the real one names just the crates that move forward.
 */
async function updateCargoDir(
  ctx: ModuleContext,
  dir: string,
  env: Record<string, string>,
  run: typeof execOk
): Promise<void> {
  const label = relative(ctx.cwd, dir) || '.';
  const managed = ctx.managedCrates ?? new Set<string>();
  const log = await run(['cargo', 'update', '--dry-run'], { cwd: dir, env }).then(
    cargoLog,
    (error: unknown) => {
      // a requirement younger than the cooldown fails the whole resolve; it clears on its own
      const young = error instanceof Error ? tooNewCrate(error.message) : null;
      if (young === null) {
        throw error;
      }
      stepNote(
        `${label}: skipped, ${young || 'a crate'} as required is younger than the release age`
      );
      return null;
    }
  );
  if (log === null) {
    return;
  }
  const plan = parseCargoUpdate(log);

  plan.downgrades
    .filter(move => !managed.has(move.name))
    .forEach(move =>
      stepNote(`${label}: kept ${move.name} ${move.from}, younger than the release age`)
    );
  const specs = plan.updates
    .filter(move => !managed.has(move.name))
    .flatMap(move => ['-p', `${move.name}@${move.from}`]);
  if (specs.length > 0) {
    await run(['cargo', 'update', ...specs], { cwd: dir, env });
  }
}

/** The module's update, with the command runner injectable for tests. */
export async function updateCargo(ctx: ModuleContext, run: typeof execOk = execOk): Promise<void> {
  const dirs = await findCargoDirs(ctx);
  if (ctx.dryRun) {
    dirs.forEach(dir => planLine(`cargo update in ${relative(ctx.cwd, dir) || '.'}`));
    return;
  }
  // sequential: the cargo dirs of a repo share cargo's registry cache and its lock
  await dirs.reduce(async (previous, dir) => {
    await previous;
    const { env, gated } = await cargoGate(ctx, dir);
    if (gated) {
      // in the dir, as rustup picks the toolchain by it
      await assertPublishAgeSupport(run, dir);
    }
    await updateCargoDir(ctx, dir, env, run);
  }, Promise.resolve());
}

export const cargoPackageManager: Module = {
  kind: ModuleKind.PackageManager,
  id: 'cargo',
  title: 'Update crates (cargo)',
  async isUsed(ctx) {
    const toggle = ctx.config.modules['cargo'];
    if (toggle !== undefined) {
      return toggle;
    }
    return (await findCargoDirs(ctx)).length > 0;
  },
  update: ctx => updateCargo(ctx),
};
