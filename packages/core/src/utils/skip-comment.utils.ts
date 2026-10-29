// `# bumper: skip` (`// bumper: skip` in JSONC), optionally followed by a reason, on the line
// right above the held line.
const SKIP_COMMENT_REGEX = /^\s*(?:#|\/\/)\s*bumper:\s*skip\b/i;

/** Whether the line at `index` is held by a `# bumper: skip` comment directly above it. A line
 * comment above works in Dockerfiles too, which know no trailing comments. */
export function isHeldLine(lines: readonly string[], index: number): boolean {
  return index > 0 && SKIP_COMMENT_REGEX.test(lines[index - 1] ?? '');
}

/** Rewrite every line of `text` that no skip comment holds, keeping line endings intact. */
export function replaceUnheldLines(
  text: string,
  replace: (line: string, index: number) => string
): string {
  const lines = text.split('\n');
  return lines
    .map((line, index) => (isHeldLine(lines, index) ? line : replace(line, index)))
    .join('\n');
}
