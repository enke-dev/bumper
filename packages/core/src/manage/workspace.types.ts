import type { PackageManager } from '../context/context.types.js';

/** A package a repo publishes: every non-private manifest in it with a name. */
export interface PublishedPackage {
  name: string;
  /** `publishConfig.registry` when set; the package manager's default registry otherwise. */
  registry?: string;
}

/** One git repository found under the manage root. */
export interface RepoInfo {
  /** Stable id: the path relative to the manage root (`owner/repo`). */
  id: string;
  /** Absolute path. */
  path: string;
  /** Root manifest name, when there is one. */
  name?: string;
  /** Root manifest `private` flag; a private root never publishes. */
  private: boolean;
  /** Detected package manager; null when bumper can't handle the repo (no manifest, yarn). */
  packageManager: PackageManager | null;
  /** Why the repo is unsupported, when it is. */
  unsupported?: string;
  published: PublishedPackage[];
  /** Union of direct dependency names across the root and workspace manifests. */
  dependencies: string[];
  /** Branch the work tree is on; null when detached or not resolvable. */
  branch: string | null;
  /** Local branches, for the push-branch picker. */
  branches: string[];
  /**
   * The manifest's `repository` points at another GitHub owner/name than `origin` does: a fork. Its
   * published names produce no graph edges (the real package comes from the original project).
   */
  fork: boolean;
}

export interface WorkspaceScan {
  root: string;
  repos: RepoInfo[];
}
