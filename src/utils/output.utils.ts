/** Terminal output helpers — ANSI palette + labeled step runner. */

export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const CYAN = '\x1b[36m';
export const RESET = '\x1b[0m';

const RED = '\x1b[31m';
const CLEAR_LINE = '\r\x1b[2K';

/** Errors whose output {@link runStep} already surfaced. Keyed by identity, so the CLI's
 * top-level handler can skip reprinting a block the failing step just printed in full. */
const reported = new WeakSet<object>();

/** Whether this error's message was already printed by {@link runStep}. */
export function wasReported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && reported.has(error);
}

/**
 * Run a labeled async step. On success collapse to a single green line; on
 * failure print a red line, surface the error output, and rethrow.
 */
export async function runStep(label: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`${DIM}> ${label} ...${RESET}`);
  try {
    await fn();
    process.stdout.write(`${CLEAR_LINE}${GREEN}✓ ${label}${RESET}\n`);
  } catch (error) {
    process.stdout.write(`${CLEAR_LINE}${RED}✗ ${label}${RESET}\n`);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (typeof error === 'object' && error !== null) {
      reported.add(error);
    }
    throw error;
  }
}

/**
 * Emit an informational line from inside a running step (e.g. a retry notice). Clears the
 * step's in-progress line first, so the trailing `✓`/`✗` lands on its own line below instead
 * of overwriting the note.
 */
export function stepNote(text: string): void {
  process.stdout.write(`${CLEAR_LINE}${DIM}  → ${text}${RESET}\n`);
}

/** Emit a planned action line (used in `--dry-run`). */
export function planLine(text: string): void {
  process.stdout.write(`${DIM}  → ${text}${RESET}\n`);
}
