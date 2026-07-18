/** Per-repo overrides, keyed by absolute path in the config file. */
export interface RepoConfig {
  /** Repo-relative paths excluded from workspace operations (e.g. vendored packages). */
  exclude: string[];
  /** Explicit module enable/disable overrides, keyed by module id. */
  modules: Record<string, boolean>;
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
