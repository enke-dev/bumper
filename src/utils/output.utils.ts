/** Terminal output helpers — ANSI palette + labeled step runner. */

export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const GREEN = '\x1b[32m';
export const CYAN = '\x1b[36m';
export const RESET = '\x1b[0m';

const RED = '\x1b[31m';
const CLEAR_LINE = '\r\x1b[2K';

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
    throw error;
  }
}

/** Emit a planned action line (used in `--dry-run`). */
export function planLine(text: string): void {
  process.stdout.write(`${DIM}  → ${text}${RESET}\n`);
}
