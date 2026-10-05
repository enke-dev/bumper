/**
 * Pure helpers for pnpm's `minimumReleaseAgeExclude` list in `pnpm-workspace.yaml`. pnpm accepts
 * two rule shapes: a name pattern (`@scope/*`) or a name with an exact-version union
 * (`name@1.0.0 || 1.0.1`, patterns not allowed with versions). bumper only ever writes the second,
 * so a fresh version is exempt without lifting the cooldown for the package as a whole.
 */

export interface ExcludeRule {
  name: string;
  /** Exact versions the rule pins; empty for a bare name/pattern rule. */
  versions: string[];
}

/** Split `name@a || b` into its parts; a bare name (or pattern) has no versions. */
export function parseExcludeRule(rule: string): ExcludeRule {
  const at = rule.indexOf('@', rule.startsWith('@') ? 1 : 0);
  if (at === -1) {
    return { name: rule.trim(), versions: [] };
  }
  return {
    name: rule.slice(0, at).trim(),
    versions: rule
      .slice(at + 1)
      .split('||')
      .map(version => version.trim())
      .filter(Boolean),
  };
}

/** `name@a || b`, quoted the way pnpm's own writer does when YAML would otherwise misread it. */
export function formatExcludeRule(rule: ExcludeRule): string {
  const text = rule.versions.length > 0 ? `${rule.name}@${rule.versions.join(' || ')}` : rule.name;
  // a leading `@` is a YAML tag marker, so scoped names need quoting
  return text.startsWith('@') ? `'${text}'` : text;
}

const KEY = 'minimumReleaseAgeExclude:';

/** Strip surrounding quotes from a YAML scalar. */
function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

/**
 * The existing list block: its line range and the rules it holds. Handles the `- item` block form
 * and the inline `[a, b]` form; absent when the key isn't declared.
 */
function locateBlock(lines: string[]): { start: number; end: number; rules: string[] } | null {
  const start = lines.findIndex(line => line.startsWith(KEY));
  if (start === -1) {
    return null;
  }
  const head = lines[start] ?? '';
  const inline = head.slice(KEY.length).trim();
  if (inline.startsWith('[')) {
    const rules = inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(unquote)
      .filter(Boolean);
    return { start, end: start + 1, rules };
  }
  // the block runs until the next top-level key (or EOF); blank and comment lines stay inside
  const rest = lines.slice(start + 1);
  const length = rest.findIndex(line => /^\S/.test(line));
  // trailing blank lines belong to whatever follows (or the file end), not to the list
  const end =
    [...rest.slice(0, length === -1 ? rest.length : length)].reduceRight(
      (last, line, index) => (last === index + 1 && line.trim() === '' ? index : last),
      length === -1 ? rest.length : length
    ) +
    start +
    1;
  const rules = rest
    .slice(0, end - start - 1)
    .map(line => line.match(/^\s*-\s+(.+)$/)?.[1])
    .filter((rule): rule is string => rule !== undefined)
    .map(unquote);
  return { start, end, rules };
}

/**
 * Replace the rules for the given names (a name with no versions removes its rule) and leave every
 * other rule, and the rest of the file, untouched. Appends the key when absent, drops it when the
 * resulting list is empty.
 */
export function upsertPnpmExcludeRules(yaml: string, rules: ReadonlyMap<string, string[]>): string {
  // one trailing newline when the input had one (a new file counts as having one)
  const finish = (text: string): string =>
    `${text.replace(/\n*$/, '')}${yaml === '' || yaml.endsWith('\n') ? '\n' : ''}`;
  const lines = yaml.split('\n');
  const block = locateBlock(lines);
  const kept = (block?.rules ?? []).map(parseExcludeRule).filter(rule => !rules.has(rule.name));
  const added = [...rules]
    .filter(([, versions]) => versions.length > 0)
    .map(([name, versions]) => ({ name, versions }));
  const next = [...kept, ...added].map(rule => `  - ${formatExcludeRule(rule)}`);

  const body = block === null ? lines : [...lines.slice(0, block.start), ...lines.slice(block.end)];
  if (next.length === 0) {
    return finish(body.join('\n'));
  }
  const blockText = [KEY, ...next].join('\n');
  if (block === null) {
    const content = body.join('\n').replace(/\n*$/, '');
    return finish(content === '' ? blockText : `${content}\n\n${blockText}`);
  }
  return finish([...lines.slice(0, block.start), blockText, ...lines.slice(block.end)].join('\n'));
}
