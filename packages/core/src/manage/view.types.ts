/**
 * What the manage GUI receives: plain data, no Node imports, so the browser bundle can share these
 * types with the server without dragging runtime modules into its type program.
 */
import type { BumperConfig, RepoConfig } from '../config/config.types.js';
import type { Diagnostic, Severity } from './diagnostics.types.js';
import type { LogStream, RepoStatus, RunEvent } from './events.js';
import type { RepoInfo } from './workspace.types.js';

/** A repo as the GUI sees it: scan data, graph position, config, diagnostics and run state. */
export interface RepoView extends RepoInfo {
  stage: number;
  upstream: string[];
  downstream: string[];
  config: RepoConfig;
  /** Whether `~/.bumperrc` has an entry (otherwise `config` is bumper's defaults). */
  configured: boolean;
  diagnostics: Diagnostic[];
  status?: RepoStatus;
  detail?: string;
}

export interface ModuleInfo {
  id: string;
  title: string;
  kind: string;
}

export interface WorkspaceView {
  root: string;
  scannedAt: number;
  stages: string[][];
  cycles: string[][];
  ambiguous: { name: string; repos: string[] }[];
  repos: RepoView[];
  modules: ModuleInfo[];
  running: boolean;
}

export interface LogLine {
  stream: LogStream;
  line: string;
  at: number;
}

export type SessionEvent =
  | RunEvent
  | { type: 'workspace'; workspace: WorkspaceView }
  | { type: 'run'; running: boolean; at: number };

export interface RunRequest {
  selection: string[];
  /** Per-run "Ignore minimum release age". */
  ignoreReleaseAge?: boolean;
}

export type { BumperConfig, Diagnostic, RepoConfig, Severity };
