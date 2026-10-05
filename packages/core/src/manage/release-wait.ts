import type { PublishedPackage } from './workspace.types.js';

/**
 * Published versions of a package as the registry lists them, or null when unresolvable (offline,
 * unauthenticated, unpublished). The real one runs `<tool> view <pkg> versions --json` in the repo
 * dir, honouring `publishConfig.registry`; tests inject a fake.
 */
export type VersionsLookup = (
  pkg: PublishedPackage,
  tool: string,
  cwd: string
) => Promise<string[] | null>;

/** Package name → versions seen before the push. */
export type VersionSnapshot = Map<string, ReadonlySet<string>>;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** `setTimeout` that resolves early when `signal` aborts (the user's "skip waiting"). */
export const sleep: Sleep = (ms, signal) =>
  new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

export async function snapshotVersions(
  packages: readonly PublishedPackage[],
  tool: string,
  cwd: string,
  lookup: VersionsLookup
): Promise<VersionSnapshot> {
  const entries = await Promise.all(
    packages.map(async pkg => [pkg.name, new Set((await lookup(pkg, tool, cwd)) ?? [])] as const)
  );
  return new Map(entries);
}

export type WaitOutcome =
  | { outcome: 'released'; versions: Record<string, string> }
  | { outcome: 'timeout'; pending: string[] }
  | { outcome: 'skipped' };

export interface WaitOptions {
  packages: readonly PublishedPackage[];
  tool: string;
  cwd: string;
  before: VersionSnapshot;
  lookup: VersionsLookup;
  timeoutMs: number;
  /** First poll delay; doubles up to `maxDelayMs`. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Aborting ends the wait as `skipped`. */
  signal?: AbortSignal;
  sleep?: Sleep;
  now?: () => number;
  /** Progress hook: the packages still without a new version after a poll. */
  onPoll?: (pending: string[]) => void;
}

/**
 * Poll the registry until every published package shows a version that wasn't there before the
 * push. Backs off geometrically, gives up at `timeoutMs`, and ends early when `signal` aborts.
 */
export async function waitForRelease(options: WaitOptions): Promise<WaitOutcome> {
  const {
    packages,
    tool,
    cwd,
    before,
    lookup,
    timeoutMs,
    initialDelayMs = 10_000,
    maxDelayMs = 60_000,
    signal,
    sleep: wait = sleep,
    now = Date.now,
    onPoll,
  } = options;
  const deadline = now() + timeoutMs;
  const released: Record<string, string> = {};

  const poll = async (delay: number): Promise<WaitOutcome> => {
    if (signal?.aborted) {
      return { outcome: 'skipped' };
    }
    const pending = packages.filter(pkg => released[pkg.name] === undefined);
    await Promise.all(
      pending.map(async pkg => {
        const seen = before.get(pkg.name) ?? new Set<string>();
        const fresh = ((await lookup(pkg, tool, cwd)) ?? []).filter(version => !seen.has(version));
        const newest = fresh.at(-1);
        if (newest !== undefined) {
          released[pkg.name] = newest;
        }
      })
    );
    const still = packages.filter(pkg => released[pkg.name] === undefined).map(pkg => pkg.name);
    onPoll?.(still);
    if (still.length === 0) {
      return { outcome: 'released', versions: released };
    }
    if (signal?.aborted) {
      return { outcome: 'skipped' };
    }
    if (now() + delay > deadline) {
      return { outcome: 'timeout', pending: still };
    }
    await wait(delay, signal);
    return poll(Math.min(delay * 2, maxDelayMs));
  };
  return poll(initialDelayMs);
}
