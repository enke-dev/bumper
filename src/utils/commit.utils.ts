import { basename } from 'node:path';

import { exec } from './exec.utils.js';
import type { PackageJson } from './package.types.js';

/** A single old → new transition (a dependency spec, an action pin, a version file). */
export interface Change {
  name: string;
  from: string;
  to: string;
}

/** Structured diff of an `update` run, grouped for the commit body. */
export interface ChangeSummary {
  deps: Change[];
  packageManager?: Change;
  node?: Change;
  bun?: Change;
  actions: Change[];
  otherFiles: string[];
}

/** A changed file with its pre-run (HEAD) and post-run contents; `before` is null for new files. */
export interface FileDiff {
  path: string;
  before: string | null;
  after: string;
}

const DEP_BUCKETS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

const USES_RE = /uses:\s*([\w.-]+\/[\w.-]+)@(\S+)/g;

function parseJson(text: string | null): PackageJson | null {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as PackageJson;
  } catch {
    return null;
  }
}

/** Every dependency spec that changed between two manifests, across all dependency buckets. */
function diffManifest(before: PackageJson, after: PackageJson): Change[] {
  const changes: Change[] = [];
  DEP_BUCKETS.forEach(bucket => {
    const from = (before[bucket] ?? {}) as Record<string, string>;
    const to = (after[bucket] ?? {}) as Record<string, string>;
    Object.entries(to).forEach(([name, spec]) => {
      if (from[name] !== undefined && from[name] !== spec) {
        changes.push({ name, from: from[name], to: spec });
      }
    });
  });
  return changes;
}

/** `uses: owner/repo@ref` pins in a workflow file, keyed by action name (last occurrence wins). */
function parseUses(text: string): Map<string, string> {
  const pins = new Map<string, string>();
  for (const match of text.matchAll(USES_RE)) {
    const [, name, ref] = match;
    if (name !== undefined && ref !== undefined) {
      pins.set(name, ref);
    }
  }
  return pins;
}

function diffUses(before: string, after: string): Change[] {
  const from = parseUses(before);
  const to = parseUses(after);
  const changes: Change[] = [];
  to.forEach((ref, name) => {
    const prev = from.get(name);
    if (prev !== undefined && prev !== ref) {
      changes.push({ name, from: prev, to: ref });
    }
  });
  return changes;
}

/**
 * Fold a set of file diffs into a grouped {@link ChangeSummary}. Pure — the git plumbing lives in
 * {@link collectChangedFiles}/{@link commitAll} — so the grouping is exercised without a repo.
 * package.json → dependency + packageManager changes; `.node-version`/`.bun-version` → runtime
 * pins; workflow YAML → action pins; anything else is listed by path.
 */
export function summarizeChanges(files: FileDiff[]): ChangeSummary {
  const summary: ChangeSummary = { deps: [], actions: [], otherFiles: [] };
  const seenDep = new Set<string>();

  for (const file of files) {
    const name = basename(file.path);

    if (name === 'package.json') {
      const before = parseJson(file.before);
      const after = parseJson(file.after);
      if (before === null || after === null) {
        summary.otherFiles.push(file.path);
        continue;
      }
      for (const change of diffManifest(before, after)) {
        const key = `${change.name}\t${change.from}\t${change.to}`;
        if (!seenDep.has(key)) {
          seenDep.add(key);
          summary.deps.push(change);
        }
      }
      if (
        before.packageManager &&
        after.packageManager &&
        before.packageManager !== after.packageManager
      ) {
        summary.packageManager = {
          name: 'packageManager',
          from: before.packageManager,
          to: after.packageManager,
        };
      }
      continue;
    }

    if (name === '.node-version' && file.before !== null) {
      summary.node = { name: 'node', from: file.before.trim(), to: file.after.trim() };
      continue;
    }
    if (name === '.bun-version' && file.before !== null) {
      summary.bun = { name: 'bun', from: file.before.trim(), to: file.after.trim() };
      continue;
    }

    if (file.path.includes('.github/workflows/') && file.before !== null) {
      summary.actions.push(...diffUses(file.before, file.after));
      continue;
    }

    summary.otherFiles.push(file.path);
  }

  return summary;
}

/** True when the summary carries nothing worth committing. */
export function isEmptySummary(s: ChangeSummary): boolean {
  return (
    s.deps.length === 0 &&
    s.actions.length === 0 &&
    s.otherFiles.length === 0 &&
    s.packageManager === undefined &&
    s.node === undefined &&
    s.bun === undefined
  );
}

/** Render the grouped summary as the markdown commit body (no subject line). */
export function renderCommitBody(s: ChangeSummary): string {
  const sections: string[] = [];
  const list = (title: string, lines: string[]): void => {
    if (lines.length > 0) {
      sections.push(`### ${title}\n\n${lines.map(line => `- ${line}`).join('\n')}`);
    }
  };

  list(
    'Dependencies',
    s.deps.map(d => `\`${d.name}\`: ${d.from} → ${d.to}`)
  );
  list(
    'Package manager',
    s.packageManager ? [`${s.packageManager.from} → ${s.packageManager.to}`] : []
  );
  list('Node', s.node ? [`${s.node.from} → ${s.node.to}`] : []);
  list('Bun', s.bun ? [`${s.bun.from} → ${s.bun.to}`] : []);
  list(
    'GitHub Actions',
    s.actions.map(a => `\`${a.name}\`: ${a.from} → ${a.to}`)
  );
  list('Other', s.otherFiles);

  return sections.join('\n\n');
}

/** Whether `cwd` is inside a git work tree. */
export async function isGitRepo(cwd: string, run: typeof exec = exec): Promise<boolean> {
  const { exitCode, stdout } = await run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd });
  return exitCode === 0 && stdout.trim() === 'true';
}

/** Files changed in the work tree vs HEAD (modified + added + untracked), with before/after content. */
export async function collectChangedFiles(
  cwd: string,
  run: typeof exec = exec
): Promise<FileDiff[]> {
  const { stdout } = await run(['git', 'status', '--porcelain', '--untracked-files=all'], { cwd });
  const paths = stdout
    .split('\n')
    .filter(Boolean)
    // porcelain lines are "XY <path>"; slice past the 2-char status + space, take rename targets
    .map(line => {
      const raw = line.slice(3).trim();
      return raw.includes(' -> ') ? (raw.split(' -> ').pop() ?? raw).trim() : raw;
    })
    .filter(Boolean);

  return Promise.all(
    paths.map(async path => {
      const [head, work] = await Promise.all([
        run(['git', 'show', `HEAD:${path}`], { cwd }),
        run(['cat', path], { cwd }),
      ]);
      return {
        path,
        before: head.exitCode === 0 ? head.stdout : null,
        after: work.exitCode === 0 ? work.stdout : '',
      };
    })
  );
}

/** Stage everything and commit with the given subject + body. Throws on git failure. */
export async function commitAll(
  cwd: string,
  subject: string,
  body: string,
  run: typeof exec = exec
): Promise<void> {
  const add = await run(['git', 'add', '-A'], { cwd });
  if (add.exitCode !== 0) {
    throw new Error(`git add failed: ${add.stderr.trim()}`);
  }
  const args = ['git', 'commit', '-m', subject, ...(body ? ['-m', body] : [])];
  const commit = await run(args, { cwd });
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  }
}
