# bumper

Central, module-based repo updater that detects a repo's runtime + package manager and bumps everything: Node LTS,
`@types/node`, all dependencies, the package manager itself, GitHub Actions pins, and Node
versions in Docker/Compose files.

## tl;dr

```sh
# run bumper in the current repo, auto-detecting everything
npx @enke.dev/bumper update         # with npm
pnpm dlx @enke.dev/bumper update    # with pnpm
bunx --bun @enke.dev/bumper update  # with Bun, no Node needed
```

Works across **node/pnpm**, **node/npm** and **bun** repos, single-package or monorepo.

Dependencies are bumped by resolving each package's latest version via the repo's own package
manager (`pnpm view` / `npm view`, so private scoped registries + `.npmrc` auth just work),
rewriting `package.json` specs (preserving `^`/`~`), then letting the package manager reinstall.

Bumps are **peer-aware**: before rewriting, bumper reads the `peerDependencies` of every direct
dependency — for the version it's about to bump _to_, resolved from the registry rather than the
stale one in `node_modules` — and caps each shared dependency to the newest version still
satisfying every declared peer range. So a preset that peer-pins `typescript` to `6.0.3`
(e.g. [`@enke.dev/lint`](https://www.npmjs.com/package/@enke.dev/lint)) holds `typescript` at
`6.0.3` instead of jumping to a newer major that would break the preset — no per-repo config
needed, the declaration lives in the dependency itself. Because the peers are read for the target
version, a peer newly introduced (or changed) by that bump is honored in the **same run** — no
second pass needed to converge.

> **Note** — network runs through subprocesses (`curl` for the Node dist index, `pnpm`/`npm view`
> for versions, `actions-up` via `bunx`), so private-registry auth is handled by the tools that
> own it — the repo's own `.npmrc` just works.

## Install

Published publicly to [npm](https://www.npmjs.com/package/@enke.dev/bumper) as `@enke.dev/bumper`.
The bin is a single bundled JS file (`dist/cli.mjs`) — no platform binaries — so it runs on
**Node ≥22** _or_ **Bun**.

### Run without installing

Use your package manager's runner to fetch + execute the latest version on the fly:

```sh
npx           @enke.dev/bumper …   # npm
pnpm dlx      @enke.dev/bumper …   # pnpm
bunx --bun    @enke.dev/bumper …   # bun (--bun forces the Bun runtime, no Node needed)
```

### Install globally

```sh
npm  install -g @enke.dev/bumper
pnpm add     -g @enke.dev/bumper
bun  add     -g @enke.dev/bumper
```

Then invoke `bumper` (or `bmpr`) directly.

### From source

Requires [Bun](https://bun.sh) to build.

```sh
bun install     # installs deps + builds ./dist/cli.mjs (prepare hook)
bun run dev …   # run the CLI straight from source, no build needed
```

To get a global `bumper` on your `PATH` from the working tree (e.g. to dogfood it in other
repos), build and link once:

```sh
bun run build   # refresh ./dist/cli.mjs
bun link        # symlinks it into ~/.bun/bin (on PATH for a standard Bun install)
```

The link tracks `dist/cli.mjs` live — re-run `bun run build` to update what `bumper` executes;
no need to link again. `bun link` writes the platform-appropriate shim, so this works on Windows too.

## Usage

```sh
bumper                        # no command → shows help
bumper help                   # show help (also: bumper --help)
bumper detect                 # show context + applicable modules for the cwd
bumper detect /path --json    # machine-readable detection
bumper update                 # run every applicable module, in order
bumper update /path/to/repo   # target another repo (defaults to cwd)
```

### Flags

All flags apply to `bumper update`; `--json` is `detect`-only and `--ignore-config` applies to
both. Repeatable flags are given several times — one value each, no comma-separated lists.

| Flag               | Repeatable | What it does                                                                                 |
| ------------------ | :--------: | -------------------------------------------------------------------------------------------- |
| `--dry-run`        |     no     | Print every intended step, change nothing on disk.                                           |
| `--only <id>`      |    yes     | Run **only** the named module(s); everything else is skipped.                                |
| `--skip <id>`      |    yes     | Run everything **except** the named module(s).                                               |
| `--exclude <path>` |    yes     | Skip a repo-relative path this run only, without editing config (see [Excludes](#excludes)). |
| `--ignore-config`  |     no     | Ignore `~/.bumperrc` for this run — auto-detect everything, read + write nothing.            |
| `--json`           |     no     | `detect` only — emit machine-readable detection output.                                      |

`--only` and `--skip` take module ids from the [Modules](#modules) table (`node`, `types-node`,
`bun`, `npm`, `pnpm`, `docker`, `github-actions`).

```sh
bumper update --dry-run                               # preview, no writes
bumper update --only node,pnpm                        # just the Node runtime + pnpm modules
bumper update --skip github-actions                   # everything but the actions pinner
bumper update --exclude examples                      # skip a path this run, without editing config
bumper update --exclude examples --exclude fixtures   # repeat the flag for several
bumper update --ignore-config                         # ignore stored excludes/toggles, pure auto-detect
```

`--ignore-config` bypasses `~/.bumperrc` completely: no entry is read for the target repo and, for
an unknown repo, none is written. Stored excludes and module toggles are skipped — use it to run
exactly what auto-detection finds, or to preview a repo without persisting a default entry.

## Modules

Each concern is a self-detecting, self-updating unit behind a common `Module` interface, in one of
three families (mirrored by the `modules/` folder layout): **runtimes**, **package-managers** and
**features**. The update procedure just runs every module whose detector matches, in registry order
— runtimes first (pin versions), then dependency-pinning features, then package managers install,
then the remaining file-rewriting features:

| id               | kind            | detects                         | does                                                                       |
| ---------------- | --------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `node`           | runtime         | node runtime / `.node-version`  | install latest LTS via fnm/asdf, write `.node-version`                     |
| `types-node`     | feature         | `@types/node` in any package    | pin spec to exact latest in the Node LTS major line                        |
| `bun`            | package-manager | bun packageManager / lockfile   | self-upgrade, bump specs, pin `.bun-version`, reinstall                    |
| `npm`            | package-manager | npm packageManager / lockfile   | bump specs to latest, clean reinstall, `approve-scripts --all`             |
| `pnpm`           | package-manager | pnpm packageManager / lockfile  | self-update, bump specs to latest, clean reinstall, `approve-builds --all` |
| `docker`         | feature         | `Dockerfile*` / `compose*.yaml` | align `node:<ver>` / `NODE_VERSION=` to LTS                                |
| `github-actions` | feature         | `.github/workflows/*.y{a,}ml`   | pin actions via `actions-up`                                               |

Adding a concern = adding one module (`*.runtime.ts` / `*.package-manager.ts` / `*.feature.ts`)
implementing the `Module` interface and registering it. `bumper detect` exposes per-module
detection, so a later multi-step CLI or GUI can build on top of the same registry.

## Config (`~/.bumperrc`)

Path-scoped overrides. Running in an unknown repo auto-detects everything and persists a default
entry, so the next run is already scoped:

```jsonc
{
  "repos": {
    "/absolute/path/to/repository": {
      "exclude": ["packages/vendored-pkg"], // repo-relative paths skipped everywhere (see below)
      "modules": { "docker": false }, // explicit per-module on/off overrides, keyed by module id
    },
  },
}
```

A stored `modules` toggle is authoritative: `docker: false` disables that module even where its
files exist, `true` forces it on. Modules with no entry fall back to auto-detection.

```sh
bumper config list
bumper config get /path/to/repo
bumper config set /path/to/repo exclude packages/a packages/b
bumper config set /path/to/repo modules.docker false
```

`bumper detect` marks anything the config drives — a forced module shows `(config: on|off)`, a
stored `exclude` shows `(config)` — with a footer pointing at the `config set` to change it and
`--ignore-config` to bypass. Run `bumper detect --ignore-config` to see what pure auto-detection
would do.

### Excludes

`exclude` is a list of repo-relative paths (an exact dir/file or any descendant) that bumper
leaves alone. It applies **uniformly**:

- workspace members under an excluded path are dropped from every workspace operation, and
- every file-discovering module (e.g. `docker`, which globs `**/Dockerfile*`) skips matches under
  an excluded path — so vendored packages, fixtures, or example projects used for testing are
  never rewritten.

Persist it with `config set … exclude` (space-separated paths, replacing the stored list), or pass
`--exclude <path>` on a single `update` run to add paths for that run only (repeat the flag for
several, merged with the stored list, not saved). The common case: a repo whose own `examples/` are
self-applied test fixtures —

```sh
bumper config set /path/to/repo exclude examples   # always skip
bumper update --exclude examples                   # skip just this run
```

> Modules that read a single fixed file at the repo root (`github-actions`, the package managers)
> are unaffected — `exclude` targets subpaths, and the root is never excluded.
