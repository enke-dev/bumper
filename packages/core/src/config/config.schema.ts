/**
 * The one description of `~/.bumperrc` every editor shares: `bumper config set` parses its CLI
 * tokens through it and the manage GUI renders its settings form from it, so a new setting is
 * added here once and both pick it up.
 */
import type { RepoConfig } from './config.types.js';

export type ConfigFieldKind = 'string' | 'boolean' | 'string-list' | 'boolean-map';

export interface ConfigField {
  /** Key in the config entry. A `boolean-map` is addressed as `<key>.<id>` on the CLI. */
  key: keyof RepoConfig;
  kind: ConfigFieldKind;
  title: string;
  description: string;
  /** Default when the entry doesn't carry the field. `undefined` = optional, absent by default. */
  default: unknown;
  /** Hint shown next to the field; for `string` fields the CLI usage token. */
  placeholder?: string;
}

export const REPO_CONFIG_FIELDS: readonly ConfigField[] = [
  {
    key: 'exclude',
    kind: 'string-list',
    title: 'Excluded paths',
    description: 'Repo-relative paths left out of workspace operations, e.g. vendored packages.',
    default: [],
    placeholder: 'path...',
  },
  {
    key: 'modules',
    kind: 'boolean-map',
    title: 'Module overrides',
    description: 'Force a module on or off instead of auto-detecting it.',
    default: {},
    placeholder: 'modules.<id> true|false',
  },
  {
    key: 'branch',
    kind: 'string',
    title: 'Push branch',
    description:
      'Branch bumper manage commits to and pushes. Empty = the branch the repo is on. A missing branch is created from the current one.',
    default: undefined,
    placeholder: 'name',
  },
  {
    key: 'checks',
    kind: 'string-list',
    title: 'Checks',
    description:
      'Commands run after the update and before the push, in order. A script name runs through the package manager, anything else as a shell command.',
    default: [],
    placeholder: 'command...',
  },
  {
    key: 'waitForRelease',
    kind: 'boolean',
    title: 'Wait for release',
    description:
      'After pushing, wait for a new version on the registry before dependents start. Skipped for private packages.',
    default: true,
  },
];

export interface GlobalConfigField {
  key: 'skipVersionCheck';
  kind: 'boolean';
  title: string;
  description: string;
  default: boolean;
}

export const GLOBAL_CONFIG_FIELDS: readonly GlobalConfigField[] = [
  {
    key: 'skipVersionCheck',
    kind: 'boolean',
    title: 'Skip version check',
    description: 'Do not look for a newer bumper during `update`.',
    default: false,
  },
];

/** The field a CLI key addresses (`exclude`, `modules.<id>`, …), or null for an unknown key. */
export function resolveConfigKey(token: string): { field: ConfigField; id?: string } | null {
  const direct = REPO_CONFIG_FIELDS.find(field => field.key === token);
  if (direct) {
    return { field: direct };
  }
  const [head, ...rest] = token.split('.');
  const map = REPO_CONFIG_FIELDS.find(field => field.kind === 'boolean-map' && field.key === head);
  const id = rest.join('.');
  return map && id ? { field: map, id } : null;
}

function parseBoolean(field: ConfigField, tokens: string[]): boolean {
  if (tokens.length !== 1 || !['true', 'false'].includes(tokens[0] ?? '')) {
    throw new Error(`${field.key} takes a single true|false value`);
  }
  return tokens[0] === 'true';
}

/**
 * Apply a `config set` key + value tokens to an entry, returning the new entry. A `string-list`
 * takes every token; an empty token list clears it. A `string` takes one token; `-`/empty removes
 * it. A `boolean` takes `true|false`; a `boolean-map` is addressed per id.
 */
export function applyConfigValue(config: RepoConfig, key: string, tokens: string[]): RepoConfig {
  const resolved = resolveConfigKey(key);
  if (resolved === null) {
    throw new Error(`unknown config key: ${key}`);
  }
  const { field, id } = resolved;
  const values = tokens.map(token => token.trim()).filter(Boolean);
  const next: RepoConfig = { ...config, modules: { ...config.modules } };
  switch (field.kind) {
    case 'string-list':
      return { ...next, [field.key]: values };
    case 'boolean':
      return { ...next, [field.key]: parseBoolean(field, values) };
    case 'boolean-map':
      next.modules[id ?? ''] = parseBoolean(field, values);
      return next;
    case 'string': {
      if (values.length > 1) {
        throw new Error(`${field.key} takes a single value`);
      }
      const [value] = values;
      if (value === undefined || value === '-') {
        const { [field.key]: _removed, ...rest } = next;
        return rest as RepoConfig;
      }
      return { ...next, [field.key]: value };
    }
  }
}

/** The CLI usage line for `config set`, derived from the fields. */
export function configKeysUsage(): string[] {
  return REPO_CONFIG_FIELDS.map(field => {
    const token =
      field.kind === 'boolean-map'
        ? field.placeholder
        : `${field.key} ${field.kind === 'boolean' ? 'true|false' : field.placeholder}`;
    return `${(token ?? field.key).padEnd(28)} ${field.description}`;
  });
}
