import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackageJson } from './package.types.js';
import { isHeldLine } from './skip-comment.utils.js';
import { realignVersionSpec } from './spec.utils.js';

/** The release a runtime is pinned to; `major` serves major-granular specs (`>=22`, `22`). */
export interface Pin {
  version: string;
  major: number;
}

const TOOL_VERSIONS = '.tool-versions';
const MISE_CONFIGS = ['mise.toml', '.mise.toml'];

// `<tool> <version> [fallbacks…]`
const TOOL_VERSIONS_LINE = /^(\s*)(\S+)(\s+)(\S+)(.*)$/;
// `node = "22"` (or a quoted key), the value single- or double-quoted
const MISE_TOOL_LINE = /^(\s*)(["']?)([\w-]+)\2(\s*=\s*)(["'])([^"']*)\5(.*)$/;
const TOML_HEADER = /^\s*\[\s*([^\]]+?)\s*\]/;
// tool managers take bare versions; the semver parse would strip a `ref:`/`prefix:` and realign it
const PLAIN_VERSION = /^\d+(?:\.\d+){0,2}$/;

/** A bare version realigned to the pin, keeping its precision, or null for anything else. */
const realignPlain = (version: string, pin: Pin) =>
  PLAIN_VERSION.test(version) ? realignVersionSpec(version, pin.version, pin.major) : null;

/**
 * Realign the version of each `tool` line in a `.tool-versions` file (asdf, mise), keeping its
 * precision (see `realignVersionSpec`). `lts`, `latest`, `system`, `ref:`/`path:` stay, as do the
 * fallback versions after the first and lines held by a `# bumper: skip` comment.
 */
export function realignToolVersions(text: string, tools: readonly string[], pin: Pin): string {
  const lines = text.split('\n');
  return lines
    .map((line, index) => {
      const match = TOOL_VERSIONS_LINE.exec(line);
      if (!match || !tools.includes(match[2] ?? '') || isHeldLine(lines, index)) {
        return line;
      }
      const [, indent, tool, gap, version, rest] = match;
      const next = realignPlain(version ?? '', pin);
      return next ? `${indent}${tool}${gap}${next}${rest}` : line;
    })
    .join('\n');
}

/**
 * Realign `node = "22"`-style lines in the `[tools]` table of a mise config, keeping precision.
 * Aliases (`lts`, `latest`), inline tables, lists and held lines stay as written.
 */
export function realignMiseTools(text: string, tools: readonly string[], pin: Pin): string {
  const lines = text.split('\n');
  // the table each line belongs to
  const tables = lines.reduce<string[]>(
    (acc, line) => [...acc, TOML_HEADER.exec(line)?.[1] ?? acc.at(-1) ?? ''],
    []
  );
  return lines
    .map((line, index) => {
      const match = MISE_TOOL_LINE.exec(line);
      if (
        !match ||
        tables[index] !== 'tools' ||
        !tools.includes(match[3] ?? '') ||
        isHeldLine(lines, index)
      ) {
        return line;
      }
      const [, indent, quote, tool, assign, valueQuote, version, rest] = match;
      const next = realignPlain(version ?? '', pin);
      return next
        ? `${indent}${quote}${tool}${quote}${assign}${valueQuote}${next}${valueQuote}${rest}`
        : line;
    })
    .join('\n');
}

/** Rewrite a file in place when it exists and the rewrite changes it; never creates one. */
async function rewriteIfExists(path: string, rewrite: (text: string) => string): Promise<void> {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) {
    return;
  }
  const next = rewrite(text);
  if (next !== text) {
    await writeFile(path, next);
  }
}

/** Realign a runtime in the tool manager configs a workspace keeps (`.tool-versions`,
 * `mise.toml`, `.mise.toml`); a workspace without one gets none. */
export async function realignToolConfigs(
  dir: string,
  tools: readonly string[],
  pin: Pin
): Promise<void> {
  await Promise.all([
    rewriteIfExists(join(dir, TOOL_VERSIONS), text => realignToolVersions(text, tools, pin)),
    ...MISE_CONFIGS.map(name =>
      rewriteIfExists(join(dir, name), text => realignMiseTools(text, tools, pin))
    ),
  ]);
}

/** Realign an existing `engines.<name>` floor, preserving operator + precision; never injects
 * an `engines` field. */
export function realignEngines(pkg: PackageJson, name: string, pin: Pin): boolean {
  const current = pkg.engines?.[name];
  const next = current && realignVersionSpec(current, pin.version, pin.major);
  if (!pkg.engines || !next || next === current) {
    return false;
  }
  pkg.engines[name] = next;
  return true;
}

interface DevEngine {
  name?: string;
  version?: string;
}

/**
 * Realign the `version` of the `devEngines` entries named `name` under the given fields — each
 * field holds an entry or a list of them — preserving operator + precision. Entries without a
 * version (any version accepted) get none.
 */
export function realignDevEngines(
  pkg: PackageJson,
  name: string,
  pin: Pin,
  fields: readonly ('runtime' | 'packageManager')[] = ['runtime']
): boolean {
  const devEngines = pkg['devEngines'] as Record<string, DevEngine | DevEngine[]> | undefined;
  const entries = fields
    .flatMap(field => devEngines?.[field] ?? [])
    .filter(entry => entry.name === name && entry.version);
  return entries.reduce((changed, entry) => {
    const next = realignVersionSpec(entry.version ?? '', pin.version, pin.major);
    if (!next || next === entry.version) {
      return changed;
    }
    entry.version = next;
    return true;
  }, false);
}
