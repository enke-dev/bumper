import { chmod, rename, writeFile } from 'node:fs/promises';

/** Package + repo bumper upgrades itself from. */
const REGISTRY_LATEST = 'https://registry.npmjs.org/@enke.dev/bumper/latest';
const RELEASE_DOWNLOAD = 'https://github.com/enke-dev/bumper/releases/download';

/** The platform triple a release asset is keyed by (mirrors `scripts/build-binaries.sh`). */
export interface Platform {
  platform: NodeJS.Platform;
  arch: string;
}

/** Filesystem seam so the replace step is testable without touching the real executable. */
export interface ReplaceOps {
  writeFile: typeof writeFile;
  chmod: typeof chmod;
  rename: typeof rename;
}

const OS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
};
const ARCH: Record<string, string> = { x64: 'x64', arm64: 'arm64' };

/** Release-asset filename for a platform, or null when no binary is published for it. */
export function assetName({ platform, arch }: Platform): string | null {
  const os = OS[platform];
  const cpu = ARCH[arch];
  if (!os || !cpu) {
    return null;
  }
  return `bmpr-${os}-${cpu}${platform === 'win32' ? '.exe' : ''}`;
}

/**
 * Latest published version via the public npm registry — a plain HTTPS GET, so it works for a
 * binary install with no package manager present. Null when offline/unresolvable (never throws).
 */
export async function latestReleaseVersion(
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  try {
    const response = await fetchImpl(REGISTRY_LATEST);
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

/** Download a specific release asset's bytes, or null on any failure (never throws). */
export async function downloadAsset(
  version: string,
  asset: string,
  fetchImpl: typeof fetch = fetch
): Promise<Uint8Array | null> {
  try {
    const response = await fetchImpl(`${RELEASE_DOWNLOAD}/v${version}/${asset}`);
    if (!response.ok) {
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Atomically swap the running executable for `bytes`. Writes a sibling temp file first, then
 * renames it over the target — an atomic replace on POSIX even while the current process runs (the
 * open inode stays valid). On Windows the running image is locked, so the current file is moved
 * aside to `<path>.old` before the new one takes its place. Rejects (caller reports) when the
 * directory isn't writable.
 */
export async function replaceExecutable(
  execPath: string,
  bytes: Uint8Array,
  isWindows = process.platform === 'win32',
  ops: ReplaceOps = { writeFile, chmod, rename }
): Promise<void> {
  const next = `${execPath}.new`;
  await ops.writeFile(next, bytes);
  await ops.chmod(next, 0o755);
  if (isWindows) {
    await ops.rename(execPath, `${execPath}.old`);
  }
  await ops.rename(next, execPath);
}
