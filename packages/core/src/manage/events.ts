/** Lifecycle of one repo inside a manage run. */
export type RepoStatus =
  | 'queued'
  | 'preparing'
  | 'updating'
  | 'checking'
  | 'pushing'
  | 'awaiting-release'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'skipped';

/** Terminal states: the run for this repo is over until the user acts. */
export const TERMINAL: ReadonlySet<RepoStatus> = new Set(['done', 'failed', 'blocked', 'skipped']);

/** States a dependent may start after. */
export const SATISFIED: ReadonlySet<RepoStatus> = new Set(['done', 'skipped']);

export type LogStream = 'stdout' | 'stderr' | 'system';

export type RunEvent =
  | { type: 'status'; repo: string; status: RepoStatus; detail?: string; at: number }
  | { type: 'log'; repo: string; stream: LogStream; line: string; at: number };

export type EventSink = (event: RunEvent) => void;
