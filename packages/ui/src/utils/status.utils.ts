import type { RepoStatus } from '@enke.dev/bumper-core/manage/events.js';
import type { Severity } from '@enke.dev/bumper-core/manage/view.types.js';

export type Variant = 'brand' | 'neutral' | 'success' | 'warning' | 'danger';

export const ACTIVE: ReadonlySet<RepoStatus> = new Set([
  'preparing',
  'updating',
  'checking',
  'pushing',
  'awaiting-release',
]);

export function statusVariant(status: RepoStatus): Variant {
  switch (status) {
    case 'done':
      return 'success';
    case 'failed':
      return 'danger';
    case 'blocked':
      return 'warning';
    case 'queued':
    case 'skipped':
      return 'neutral';
    default:
      return 'brand';
  }
}

export function severityVariant(severity: Severity): Variant {
  return severity === 'error' ? 'danger' : severity === 'warning' ? 'warning' : 'neutral';
}

/** Human label; the enum values are already readable except for the hyphenated one. */
export function statusLabel(status: RepoStatus): string {
  return status.replace('-', ' ');
}
