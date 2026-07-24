import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Basic credentials for a registry, resolved from the local Docker config. */
export interface RegistryAuth {
  username: string;
  password: string;
}

interface DockerConfig {
  auths?: Record<string, { auth?: string }>;
}

/** Docker's assorted spellings of the Hub registry key in `~/.docker/config.json`. */
const HUB_KEYS = [
  'https://index.docker.io/v1/',
  'index.docker.io',
  'docker.io',
  'registry-1.docker.io',
];

/** Injection seam for tests (real home + reader by default). */
export interface DockerConfigOptions {
  home?: string;
  read?: (path: string) => Promise<string>;
}

/**
 * Resolve Basic credentials for `registry` from `~/.docker/config.json` — populated by `docker
 * login` locally and by `docker/login-action` in CI, so the same read covers both. Inline `auths`
 * only: a `credsStore`/`credHelpers` config delegates to a helper *binary*, which we deliberately
 * don't shell (it would break bundling into a standalone binary) — those resolve to null (anonymous
 * + a caller-side note). Best-effort: a missing/unreadable/garbled config yields null.
 */
export async function readDockerConfigAuth(
  registry: string,
  options: DockerConfigOptions = {}
): Promise<RegistryAuth | null> {
  const home = options.home ?? homedir();
  const read = options.read ?? ((path: string) => readFile(path, 'utf8'));
  try {
    const config = JSON.parse(await read(join(home, '.docker', 'config.json'))) as DockerConfig;
    const keys = HUB_KEYS.includes(registry)
      ? HUB_KEYS
      : [registry, `https://${registry}`, `https://${registry}/`];
    const encoded = keys.map(key => config.auths?.[key]?.auth).find(Boolean);
    if (encoded === undefined) {
      return null;
    }
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator === -1) {
      return null;
    }
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}
