import type { RepoInfo } from './workspace.types.js';

/** A package name claimed by more than one repo: the edge can't be attributed. */
export interface AmbiguousProducer {
  name: string;
  repos: string[];
}

export interface RepoGraph {
  /** Package name → the repo id publishing it (unambiguous producers only). */
  producers: Map<string, string>;
  /** Repo id → ids of the repos it depends on (within the workspace). */
  upstream: Map<string, string[]>;
  /** Repo id → ids of the repos depending on it. */
  downstream: Map<string, string[]>;
  /** Topological layers: a repo sits one stage after its deepest upstream. Cycle members land in
   * the last stage. */
  stages: string[][];
  /** Strongly connected components of size > 1 (or a self edge). */
  cycles: string[][];
  ambiguous: AmbiguousProducer[];
}

/** Strongly connected components (Tarjan), returned as the ones that form a cycle. */
function cycles(ids: string[], upstream: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (id: string): void => {
    index.set(id, index.size);
    low.set(id, index.get(id) ?? 0);
    stack.push(id);
    onStack.add(id);
    (upstream.get(id) ?? []).forEach(next => {
      if (!index.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id) ?? 0, index.get(next) ?? 0));
      }
    });
    if (low.get(id) === index.get(id)) {
      const component = stack.splice(stack.lastIndexOf(id)).sort();
      component.forEach(member => onStack.delete(member));
      if (component.length > 1 || (upstream.get(id) ?? []).includes(id)) {
        found.push(component);
      }
    }
  };
  ids.forEach(id => {
    if (!index.has(id)) {
      visit(id);
    }
  });
  return found;
}

/**
 * Derive the repo dependency graph: an edge from a repo to every repo publishing one of its
 * dependencies. Private manifests and forks never produce; a name published by several repos is reported as
 * ambiguous and produces no edge. Stages are Kahn layers; whatever can't be layered (cycles) is
 * appended as the final stage and listed in `cycles`.
 */
export function buildGraph(repos: readonly RepoInfo[]): RepoGraph {
  const ids = repos.map(repo => repo.id);
  const claims = repos
    .filter(repo => !repo.fork)
    .flatMap(repo => repo.published.map(pkg => [pkg.name, repo.id] as const))
    .reduce<Map<string, string[]>>(
      (acc, [name, id]) => acc.set(name, [...new Set([...(acc.get(name) ?? []), id])]),
      new Map()
    );
  const ambiguous = [...claims]
    .filter(([, owners]) => owners.length > 1)
    .map(([name, owners]) => ({ name, repos: owners }));
  const producers = new Map(
    [...claims]
      .filter(([, owners]) => owners.length === 1)
      .map(([name, owners]) => [name, owners[0] as string])
  );
  const upstream = new Map(
    repos.map(repo => [
      repo.id,
      [
        ...new Set(
          repo.dependencies
            .map(name => producers.get(name))
            .filter((id): id is string => id !== undefined && id !== repo.id)
        ),
      ].sort(),
    ])
  );
  const downstream = new Map(ids.map(id => [id, [] as string[]]));
  upstream.forEach((ups, id) => ups.forEach(up => downstream.get(up)?.push(id)));

  const stages: string[][] = [];
  const placed = new Set<string>();
  const layer = (): string[] =>
    ids.filter(id => !placed.has(id) && (upstream.get(id) ?? []).every(up => placed.has(up)));
  // reduce over the id count: each pass places at least one repo or the rest is cyclic
  ids.reduce<boolean>((done, _id) => {
    if (done) {
      return done;
    }
    const next = layer();
    if (next.length === 0) {
      return true;
    }
    stages.push(next);
    next.forEach(id => placed.add(id));
    return placed.size === ids.length;
  }, false);
  const rest = ids.filter(id => !placed.has(id));
  if (rest.length > 0) {
    stages.push(rest);
  }
  return { producers, upstream, downstream, stages, cycles: cycles(ids, upstream), ambiguous };
}

/** Every repo reachable downstream of `id` (transitive dependents), excluding `id`. */
export function transitiveDependents(graph: RepoGraph, id: string): string[] {
  const seen = new Set<string>();
  const walk = (current: string): void =>
    (graph.downstream.get(current) ?? []).forEach(next => {
      if (!seen.has(next)) {
        seen.add(next);
        walk(next);
      }
    });
  walk(id);
  return [...seen].sort();
}

/** The stage index a repo sits in. */
export function stageOf(graph: RepoGraph, id: string): number {
  return graph.stages.findIndex(stage => stage.includes(id));
}
