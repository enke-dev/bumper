/** Whether a repo's config entry is auto-maintained or hand-edited. */
export enum ConfigMode {
  Auto = 'auto',
  Manual = 'manual',
}

/** Per-repo overrides, keyed by absolute path in the config file. */
export interface RepoConfig {
  /** `auto` = re-detect toggles each run; `manual` = respect stored values verbatim. */
  mode: ConfigMode;
  /** Repo-relative paths excluded from workspace operations (e.g. vendored packages). */
  exclude: string[];
  /** Explicit module enable/disable overrides, keyed by module id. */
  modules: Record<string, boolean>;
}

/** Shape of `~/.bumperrc`. */
export interface BumperConfig {
  repos: Record<string, RepoConfig>;
}
