export type Severity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  /** Stable machine id (`dirty-tree`, `graph-cycle`, …) the UI keys icons/filters on. */
  code: string;
  severity: Severity;
  message: string;
}
