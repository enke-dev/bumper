import type { ModuleContext } from '../context/context.types.js';

// Re-exported so modules can import both `Module` and `ModuleContext` from here.
export type { ModuleContext } from '../context/context.types.js';

/** The three module families, mirrored by the `modules/` folder layout. */
export enum ModuleKind {
  Runtime = 'runtime',
  PackageManager = 'package-manager',
  Feature = 'feature',
}

/**
 * A self-detecting, self-updating unit of work (node, pnpm, github-actions, ...).
 * The generic update procedure iterates the registry and runs every module
 * whose `isUsed()` returns true, so adding a concern = adding one `Module`.
 */
export interface Module {
  /** Family this module belongs to. */
  kind: ModuleKind;
  /** Stable identifier, used for `--only`/`--skip` and config toggles. */
  id: string;
  /** Human label shown by `runStep`. */
  title: string;
  /** Detection: is this module relevant to the current repo? */
  isUsed(ctx: ModuleContext): Promise<boolean>;
  /**
   * Dependency names this module owns when {@link isUsed} — the generic dependency
   * bump skips them so the module can pin them itself (e.g. the types-node feature
   * owns `@types/node`, the typescript feature owns `typescript`). Omit when the
   * module manages no specific package.
   */
  managedDependencies?(ctx: ModuleContext): Promise<string[]>;
  /**
   * Container image repositories this module owns when {@link isUsed} — the generic docker
   * base-image bump skips them so the module can pin them itself (e.g. the docker-node feature
   * owns the `node` image, holding it at the current LTS rather than the newest major). Repos are
   * matched as written on the `FROM`/`image:` line (`node`, `library/node`, `ghcr.io/x/y`). Omit
   * when the module manages no specific image.
   */
  managedImages?(ctx: ModuleContext): Promise<string[]>;
  /** Action: perform the bump. Must honor `ctx.dryRun`. */
  update(ctx: ModuleContext): Promise<void>;
}
