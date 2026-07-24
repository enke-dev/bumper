<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@enke.dev/bumper/assets/icon/icon.png" alt="bumper" width="128" />
</p>

# Bumper

Central, module-based repo updater that detects a repo's runtime + package manager and bumps everything: Node LTS,
`@types/node`, all dependencies, the package manager itself, GitHub Actions pins, Node versions in
Docker/Compose files, and other base-image tags referenced there.

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

> **Note** — most network runs through subprocesses (`curl` for the Node dist index, `pnpm`/`npm
view` for versions, `actions-up` via `bunx`), so private-registry auth is handled by the tools
> that own it — the repo's own `.npmrc` just works. The `docker-images` feature is the exception: it
> talks to container registries directly over HTTPS (OCI Distribution API), reading credentials
> from `~/.docker/config.json` (populated by `docker login` locally, `docker/login-action` in CI).

## Install

Published publicly to [npm](https://www.npmjs.com/package/@enke.dev/bumper) as `@enke.dev/bumper`
(a single bundled JS file, `dist/cli.mjs`, running on **Node ≥22** _or_ **Bun**), and as
**self-contained binaries** per platform on the [GitHub releases](https://github.com/enke-dev/bumper/releases)
(the Bun runtime embedded — no local Node/Bun needed).

### Standalone binary (no runtime needed)

Downloads the binary matching your platform from the latest release into `~/.local/bin`
(override with `BUMPER_INSTALL_DIR`):

```sh
curl -fsSL https://raw.githubusercontent.com/enke-dev/bumper/main/install.sh | sh
```

Then invoke `bmpr` directly. Handy when the local Node is too old for the JS bin.

Keep it current with `bmpr upgrade` — it downloads the latest release for your platform and
replaces the running binary in place (re-running `install.sh` works too). A package-manager
install ignores this and is upgraded through that manager instead (the command says so and prints
the global-install command). During `bumper update` an out-of-date binary is flagged with the same
`bumper upgrade` hint rather than a package-manager one.

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
bumper upgrade                # update the bumper binary itself (standalone install only)
```

Every invocation prints a one-line `bumper v<version>` banner (suppressed under `--json`). During
`update`, bumper also checks the registry for a newer release of itself — the lookup runs
concurrently with the module work, so it adds no perceptible latency — and, if one exists, prints a
hint with the install command afterwards. The check is silent when offline/unresolvable. Skip it
for a single run with `--skip-update-check`, or disable it globally by setting `skipVersionCheck`
in `~/.bumperrc` (top level, next to `repos`).

### Flags

All flags apply to `bumper update`; `--json` is `detect`-only and `--ignore-config` applies to
both. Repeatable flags are given several times — one value each, no comma-separated lists.

| Flag                     | Repeatable | What it does                                                                                 |
| ------------------------ | :--------: | -------------------------------------------------------------------------------------------- |
| `--dry-run`              |     no     | Print every intended step, change nothing on disk.                                           |
| `--commit`, `-c`         |     no     | After updating, commit the changes as `chore: update dependencies` with a summary.           |
| `--only <id>`            |    yes     | Run **only** the named module(s); everything else is skipped.                                |
| `--skip <id>`            |    yes     | Run everything **except** the named module(s).                                               |
| `--exclude`, `-e <path>` |    yes     | Skip a repo-relative path this run only, without editing config (see [Excludes](#excludes)). |
| `--ignore-config`        |     no     | Ignore `~/.bumperrc` for this run — auto-detect everything, read + write nothing.            |
| `--json`                 |     no     | `detect` only — emit machine-readable detection output.                                      |

`--only` and `--skip` take module ids from the [Modules](#modules) table (`node`, `types-node`,
`bun`, `npm`, `pnpm`, `docker-node`, `docker-images`, `github-actions`).

```sh
bumper update --dry-run                               # preview, no writes
bumper update --only node,pnpm                        # just the Node runtime + pnpm modules
bumper update --skip github-actions                   # everything but the actions pinner
bumper update --exclude examples                      # skip a path this run, without editing config
bumper update --exclude examples --exclude fixtures   # repeat the flag for several
bumper update --ignore-config                         # ignore stored excludes/toggles, pure auto-detect
bumper update --commit                                # update, then commit with a summary
```

With `--commit` (`-c`), bumper stages everything and commits as `chore: update dependencies` once
the run finishes, with a markdown body grouping what changed — dependency specs (`old → new`), the
`packageManager` field, the Node/Bun version pins, and GitHub Action pins, with any other touched
files listed by path. The changes are read back from git after the run, so the summary reflects
exactly what landed. Skipped (with a note) when the target isn't a git repo, when nothing changed,
or under `--dry-run`.

`--ignore-config` bypasses `~/.bumperrc` completely: no entry is read for the target repo and, for
an unknown repo, none is written. Stored excludes and module toggles are skipped — use it to run
exactly what auto-detection finds, or to preview a repo without persisting a default entry.

## Modules

Each concern is a self-detecting, self-updating unit behind a common `Module` interface, in one of
three families (mirrored by the `modules/` folder layout): **runtimes**, **package-managers** and
**features**. The update procedure just runs every module whose detector matches, in registry order
— runtimes first (pin versions), then dependency-pinning features, then package managers install,
then the remaining file-rewriting features:

| id               | kind            | detects                         | does                                                                                                                                  |
| ---------------- | --------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `node`           | runtime         | node runtime / `.node-version`  | install latest LTS via fnm/asdf, write `.node-version` + any `.nvmrc`, align `engines.node`                                           |
| `types-node`     | feature         | `@types/node` in any package    | pin spec to exact latest in the Node LTS major line                                                                                   |
| `bun`            | package-manager | bun packageManager / lockfile   | self-upgrade, bump specs, pin `.bun-version`, reinstall                                                                               |
| `npm`            | package-manager | npm packageManager / lockfile   | bump specs to latest, clean reinstall, `approve-scripts --all`                                                                        |
| `pnpm`           | package-manager | pnpm packageManager / lockfile  | self-update, bump specs to latest, clean reinstall, `approve-builds --all`                                                            |
| `docker-node`    | feature         | `Dockerfile*` / `compose*.yaml` | align `node:<ver>` / `NODE_VERSION=` to LTS                                                                                           |
| `docker-images`  | feature         | `Dockerfile*` / `compose*.yaml` | bump other base-image tags to newest (same variant + precision), repinning any digest, via the OCI registry API (Docker Hub, GHCR, …) |
| `github-actions` | feature         | `.github/workflows/*.y{a,}ml`   | pin actions via `actions-up`                                                                                                          |

Adding a concern = adding one module (`*.runtime.ts` / `*.package-manager.ts` / `*.feature.ts`)
implementing the `Module` interface and registering it. `bumper detect` exposes per-module
detection, so a later multi-step CLI or GUI can build on top of the same registry.

## GitHub Action

The composite action at the repo root runs `bumper update --commit`, pushes the result to a
dedicated branch, and opens (or updates) a pull request — no local installation needed. Drop it
into a scheduled workflow in any target repo.

### Minimal setup

Create `.github/workflows/update-dependencies.yml` in your repo:

```yaml
name: update dependencies

on:
  schedule:
    - cron: '0 6 * * 1' # every Monday at 06:00 UTC
  workflow_dispatch: # also allow manual runs

jobs:
  update-dependencies:
    runs-on: ubuntu-latest
    permissions:
      contents: write # push the update branch
      pull-requests: write # open the PR
    steps:
      - uses: enke-dev/bumper@main
        with:
          base: main
```

The job needs `contents: write` (to push the update branch) and `pull-requests: write` (to open
the PR), as shown above.

> **Prerequisite** — GitHub disables Actions-authored PRs by default. Enable **Settings → Actions →
> General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"**
> (also settable org-wide). Without it the branch is still pushed, but PR creation fails with
> `GitHub Actions is not permitted to create or approve pull requests`.
> Alternatively, pass a PAT or GitHub App token via the
> [`token`](#inputs) input, which bypasses the setting **and** lets the resulting PR trigger your
> other `pull_request` workflows (a bot's default `GITHUB_TOKEN` won't).

### Inputs

All inputs are optional.

| Input       | Default                      | Description                                                                                                  |
| ----------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `base`      | repository default branch    | Base branch for the PR.                                                                                      |
| `branch`    | `chore/bumper-update`        | Branch name used for the update commit and PR.                                                               |
| `pr-title`  | `chore: update dependencies` | Title of the created or updated PR.                                                                          |
| `pr-labels` | _(none)_                     | Comma-separated labels to apply to the PR (labels must already exist in the repo).                           |
| `only`      | _(all modules)_              | Run only the listed module ids (comma-separated, e.g. `node,pnpm`).                                          |
| `skip`      | _(none)_                     | Skip the listed module ids (comma-separated, e.g. `docker-node`).                                            |
| `exclude`   | _(none)_                     | Space-separated repo-relative paths to exclude (e.g. `examples fixtures`).                                   |
| `token`     | `${{ github.token }}`        | Token used to push the branch and open the PR (pass a PAT/app token to have the PR trigger other workflows). |

Module ids are the values from the `id` column in the [Modules](#modules) table.

### Outputs

| Output      | Description                                                      |
| ----------- | ---------------------------------------------------------------- |
| `updated`   | `"true"` when bumper produced a new commit, otherwise `"false"`. |
| `branch`    | The update branch name.                                          |
| `base`      | The resolved base branch.                                        |
| `pr-number` | The created or updated PR number (empty when nothing changed).   |

### Running steps afterwards

Because it's a step-level action, add your own steps in the same job — they run after the PR is
created. Use the outputs to gate them:

```yaml
jobs:
  update-dependencies:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - id: bump
        uses: enke-dev/bumper@main
        with:
          base: main
      - if: steps.bump.outputs.updated == 'true'
        run: echo "Opened PR #${{ steps.bump.outputs.pr-number }}"
```

### Full example

```yaml
name: update dependencies

on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:

jobs:
  update-dependencies:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: enke-dev/bumper@main
        with:
          base: main
          branch: chore/bumper-update
          pr-title: 'chore: update dependencies'
          pr-labels: 'dependencies,automated'
          skip: docker-node
          exclude: examples fixtures
```

## Config (`~/.bumperrc`)

Path-scoped overrides. Running in an unknown repo auto-detects everything and persists a default
entry, so the next run is already scoped:

```jsonc
{
  "skipVersionCheck": true, // global: silence the update self-version check (default: check)
  "repos": {
    "/absolute/path/to/repository": {
      "exclude": ["packages/vendored-pkg"], // repo-relative paths skipped everywhere (see below)
      "modules": { "docker-node": false }, // explicit per-module on/off overrides, keyed by module id
    },
  },
}
```

A stored `modules` toggle is authoritative: `docker-node: false` disables that module even where its
files exist, `true` forces it on. Modules with no entry fall back to auto-detection.

```sh
bumper config list
bumper config get                              # current repo (path defaults to cwd)
bumper config get /path/to/repo                # another repo
bumper config set exclude packages/a packages/b  # current repo
bumper config set /path/to/repo modules.docker-node false
```

`get` and `set` default the path to the current repo — omit it to configure where you're standing.
For `set` a leading config key (`exclude`, `modules.<id>`) is what signals the path was omitted.

`bumper detect` marks anything the config drives — a forced module shows `(config: on|off)`, a
stored `exclude` shows `(from config)` — with a footer pointing at the `config set` to change it and
`--ignore-config` to bypass. Run `bumper detect --ignore-config` to see what pure auto-detection
would do.

### Excludes

`exclude` is a list of repo-relative paths (an exact dir/file or any descendant) that bumper
leaves alone. It applies **uniformly**:

- workspace members under an excluded path are dropped from every workspace operation, and
- every file-discovering module (e.g. `docker-node`, which globs `**/Dockerfile*`) skips matches under
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
