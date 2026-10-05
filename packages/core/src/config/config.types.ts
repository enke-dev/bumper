/** Per-repo overrides, keyed by absolute path in the config file. */
export interface RepoConfig {
  /** Repo-relative paths excluded from workspace operations (e.g. vendored packages). */
  exclude: string[];
  /** Explicit module enable/disable overrides, keyed by module id. */
  modules: Record<string, boolean>;
  /**
   * Branch `bumper manage` commits to and pushes. Absent = the branch the repo is on. A branch
   * that doesn't exist yet is created from the current one.
   */
  branch?: string;
  /**
   * Commands `bumper manage` runs after the update, in order, before pushing. A bare name that
   * matches a `scripts` entry runs through the repo's package manager; anything else runs as a
   * shell command.
   */
  checks: string[];
  /**
   * Whether `bumper manage` waits for the pushed commit to show up as a new version on the
   * registry before starting dependents. Ignored for `"private": true` repos.
   */
  waitForRelease: boolean;
}

/** Shape of `~/.bumperrc`. */
export interface BumperConfig {
  /**
   * Global: skip the `update` self-version check (the newer-bumper hint). Absent = check
   * (the default). Overridden per run by `--skip-update-check`.
   */
  skipVersionCheck?: boolean;
  repos: Record<string, RepoConfig>;
}
