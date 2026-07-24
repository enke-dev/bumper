import { parseFamiliarName } from '@swimlane/docker-reference';

import type { ModuleContext } from '../context/context.types.js';
import { collectFiles } from './fs.utils.js';

/** Dockerfiles + compose manifests, matched anywhere in the tree. */
export const DOCKER_GLOB =
  '**/{Dockerfile*,docker-compose*.yaml,docker-compose*.yml,compose*.yaml,compose*.yml}';

/** Locate Docker/compose files, honoring `exclude` and skipping dependency dirs. Shared by the
 * docker-node feature (aligns the Node version) and the docker-images feature (bumps base images). */
export function findDockerFiles(ctx: ModuleContext): Promise<string[]> {
  return collectFiles(ctx.cwd, DOCKER_GLOB, ctx.config.exclude);
}

/** Whether a file's basename is a Dockerfile or a compose manifest (matches {@link DOCKER_GLOB}). */
export function isDockerFileName(name: string): boolean {
  return /^Dockerfile/.test(name) || /^(docker-)?compose.*\.ya?ml$/.test(name);
}

// `FROM [--platform=…] <ref> [AS stage]` — capture the ref, ignore the optional platform + stage.
const FROM_RE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim;
// compose `image: repo:tag` (optionally quoted).
const IMAGE_RE = /^\s*image:\s*["']?([^\s"']+)["']?/gim;

/** Every base-image reference declared in a Dockerfile or compose file's text. */
export function parseImageRefs(text: string): string[] {
  const refs = [
    ...[...text.matchAll(FROM_RE)].map(match => match[1]),
    ...[...text.matchAll(IMAGE_RE)].map(match => match[1]),
  ].filter((ref): ref is string => ref !== undefined);
  // `FROM scratch` is the empty base image — nothing to bump.
  return refs.filter(ref => ref !== 'scratch');
}

/** An image reference decomposed + normalized to docker's canonical form. */
export interface ImageRef {
  /** Normalized registry host — `docker.io`, `ghcr.io`, `myreg:5000`. Always present. */
  domain: string;
  /** Full repository path including any implicit `library/` — `library/postgres`, `x/y`. */
  repository: string;
  /** The tag, or null when the ref pins none (implicit `latest`). */
  tag: string | null;
  /** The `@sha256:…` digest, or null when unpinned. */
  digest: string | null;
}

/** Decompose + normalize a single ref via docker's canonical grammar, or null if unparseable. */
export function parseImageRef(raw: string): ImageRef | null {
  try {
    const reference = parseFamiliarName(raw.trim());
    if (reference.domain === undefined || reference.repository === undefined) {
      return null;
    }
    return {
      domain: reference.domain,
      repository: reference.repository,
      tag: reference.tag ?? null,
      digest: reference.digest ?? null,
    };
  } catch {
    return null;
  }
}

/** Registry-qualified identity of a ref (`docker.io/library/node`), for pairing + owned-matching. */
export function refKey(ref: ImageRef): string {
  return `${ref.domain}/${ref.repository}`;
}
