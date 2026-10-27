# Plan: `bmpr manage` — cascading multi-repo updates with a local web GUI

## Goal

A `bmpr manage [path]` subcommand that scans a folder of repositories, shows them grouped by
dependency stage, and runs `bmpr update -afc` → checks → push → (optional) wait for release,
stage by stage, so each dependent consumes the freshly published versions of its upstream repos.
The manager is also a full settings GUI for `~/.bumperrc`.

## Decisions

- **Repos:** every git repo under the entry path with a `package.json` that `bumper detect`
  recognises (npm, pnpm, bun; yarn later via core). Others shown greyed out.
- **Graph:** repo dependencies are derived by matching `package.json` dependencies against package
  names published by other repos in the folder. Grouped into stages (topological layers).
  Cycles become a diagnostic, not a crash.
- **Selection:** no automatic cascade. Each checkbox controls only its repo. Unchecked repos that
  depend on a checked one show an "upstream changes" badge. Each item offers "select with
  dependents". Checkboxes are disabled during a run.
- **Failure:** failed repo offers Retry; its dependents become "blocked" and offer Run anyway
  (consumes whatever upstream version is published). Independent repos continue.
- **Parallelism:** repos in the same stage run in parallel. Status visible in the list; the log
  panel shows only the selected repo.
- **Checks:** independent from GitHub workflows. Per-repo list of commands (npm scripts or free
  commands), persisted in `~/.bumperrc`.
- **Branch:** per repo, chosen from existing branches or "custom" (first option, requires input).
  Persisted in `~/.bumperrc`. A custom branch that doesn't exist is created from the current one.
- **Wait for release:** per-repo checkbox, default on. No GitHub run polling. Detection by polling
  the registry with the repo's own package manager (`view`, run in the repo dir so `.npmrc` scope
  mapping and auth apply; honour `publishConfig.registry`). Compare version lists before/after push.
  Ends on a new version, timeout, or manual Skip waiting. `"private": true` packages skip it.
- **Unconfigured repos:** use bumper's defaults. Show diagnostics (extensible list): no checks
  configured, dirty tree, behind remote, missing registry auth, graph cycle, outdated bumper, …
- **Minimum release age:** the repo's setting is respected. Per-run checkbox "Ignore minimum release
  age" relaxes bumper's resolution and the package manager's install gate for the local install.
  For pnpm 11 this is not safe on its own (see Phase 0 findings): the pushed lockfile is re-checked
  on every later install, so the repo's CI would fail until the cooldown passes. **Decided
  (2026-10-05):** no scope-wide excludes. When a pnpm repo consumes a fresh version of a package
  produced by another repo in the folder, bumper appends a version-pinned rule
  (`@scope/name@x.y.z`, merged into an existing `name@a || b` union) to `minimumReleaseAgeExclude`
  in `pnpm-workspace.yaml` as part of the update commit, and prunes rules whose versions are older
  than the cooldown. pnpm's own `audit --fix` writes the same kind of rule. bun repos need nothing.
- **Ships in the binary and npm package** (the built UI is tiny). **Decided (2026-10-05):** `manage`
  requires Bun. `Bun.serve` (built-in WebSocket), `Bun.embeddedFiles` in the binary, assets from
  disk when run via `bunx --bun`. Under Node the command exits with a hint to install the binary or
  use `bunx --bun`. Every other command stays Node-compatible.

## Phase 0 — Verification (before any code)

1. `wa-tree` (Web Awesome 3.x): confirm multiple-selection parent/child syncing from source, and
   that a slotted `wa-checkbox` in `single` mode doesn't conflict with tree click/keyboard handling.
2. pnpm and bun: per-run override for `minimumReleaseAge` (CLI flag or env var) at install time.
3. Registry polling against npmjs and GitHub Packages: auth, caching (`--prefer-online`), presence
   of `time`, `publishConfig` handling.
4. Reference project (newest repos, e.g. daimlertruck-elektrotrucker): build tooling,
   `@enke.dev/lint` setup, base element with opt-in global styles
   (`BumperElement.withGlobalStyles().withStyles(styles)`), how Web Awesome + utilities are loaded.
5. `bun build --compile`: embedding and serving the built UI assets from the binary.

## Phase 0 findings (2026-10-05)

1. **`wa-tree` (3.14.0, `src/components/tree/tree.ts`)** — confirmed: in `multiple`,
   `syncParentItem` sets `parent.selected = children.every(selected)` and `indeterminate` for
   partial states, so a parent can't stay checked with an unchecked child. Use `single` + slotted
   `wa-checkbox`. Notes: `handleClick` uses `target.closest('wa-tree-item')`, so a checkbox click
   also selects the item (fits "select = show log"; otherwise stop propagation).
   `handleKeyDown` ignores keys whose composed path contains an `input`, so keyboard toggling of a
   `wa-checkbox` (internal input) doesn't trigger tree navigation.
2. **pnpm (main, 11.28.4)** — `--minimum-release-age` is a CLI option and CLI options override
   `pnpm-workspace.yaml` (`Object.assign(settingsFromManifest, configFromCliOpts)` in
   `workspaceManifestSettings.ts`). `pnpm_config_*` env vars do **not** override the workspace yaml
   (pnpm/pnpm#10060), so use the flag, not env. **Blocker for the per-run override:** every install
   runs `verifyLockfileResolutions`, re-applying `minimumReleaseAge` to lockfile entries regardless
   of `minimumReleaseAgeStrict` (unless `trustLockfile`). A lockfile pushed with a fresh version fails
   `pnpm install` in that repo's CI (including its release workflow) until the cooldown passes.
   `minimumReleaseAgeExclude` in the repo config is the only clean fix. Pattern matching
   (`createPackageVersionPolicy` → `createMatcher(packageName)`, `@pnpm/matcher`) accepts globs, so
   `@enke.dev/*` / `@optiscaners/*` are valid entries (verified in the 11.16.0 bundle).
3. **bun (main)** — `--minimum-release-age <seconds>` (≥ 0) is applied after bunfig, so it
   overrides. `--frozen-lockfile` keeps existing versions regardless of the cooldown (test
   `minimum-release-age.test.ts`), so a pushed lockfile doesn't break later installs.
4. **Registry polling** — resolved locally (npm 11.19.0, pnpm 11.18.0 with source read from the
   local 11.16.0 bundle, bun 1.4.2) against npmjs (`@enke.dev/bumper`) and GitHub Packages
   (`@optiscaners/service-kit`):
   - `time` is present on both registries for `npm view`, `pnpm view` and `bun info`
     (`<pkg> time --json`; npmjs ms precision, GitHub Packages second precision). `versions --json`
     works on both too.
   - Caching: `npm view` hardcodes `preferOnline: true` (`lib/commands/view.js:40,135`) → every call
     revalidates, no flag needed. `pnpm view` is pnpm's own command (`deps/inspection/commands/lib/
view`, `commandNames = ["view","info","show","v"]`); its `fetchPackageInfo` calls
     `fetchMetadataFromFromRegistry({ fullMetadata: true })` without the meta cache → always network.
     pnpm has no `--prefer-online`, rejects `--userconfig` ("Unknown option"), honours
     `NPM_CONFIG_USERCONFIG`. `bun info` uses the manifest cache: entries are fresh for 300 s
     (`npm.rs`: `public_max_age = now + 300`), expired entries are revalidated via etag/last-modified
     (`PackageManagerEnqueue.rs`). Use `bun info --no-cache` ("Ignore manifest cache entirely"), or
     keep bumper's existing `viewTool()` (pnpm → `pnpm`, else `npm`).
   - `publishConfig.registry`: `npm view --registry <url>` / `pnpm view --registry <url>` work from
     any cwd (auth resolved per host from `~/.npmrc`). All GitHub Packages producers here map
     `@optiscaners` in `~/.npmrc`; `tutorials`/`pitstop` also in a project `.npmrc`, `service-kit`
     has none. Plan: run in the repo dir and additionally pass `--registry` when
     `publishConfig.registry` is set.
   - Missing auth: npm → exit 1, JSON on stdout `{"error":{"code":"E401","summary":"401
Unauthorized … authentication token not provided"}}`; unmapped scope → `E404` against npmjs.
     pnpm → `{"error":{"code":"ERR_PNPM_FETCH_401"}}`. `bun info` outside a project dies with "Bun
     could not find a package.json" → must run inside the repo. These codes drive the "missing
     registry auth" diagnostic.
   - Latency per call: npm 0.35–1.0 s, pnpm 0.75–0.85 s, bun 0.15–0.6 s.
   - Reuse: `src/utils/npm-registry.utils.ts` already has `publishTimes`, `latestWithTimes`,
     `maxSatisfyingRanges` (`versions --json`) and `viewTool`; the release wait builds on these.
5. **Embedding** — `bun build --compile ./entry.ts ./ui/dist/**/*` embeds files, listed via
   `Bun.embeddedFiles`. **Caveat:** the npm package also runs on Node ≥ 22, where `Bun.serve` and
   `Bun.embeddedFiles` don't exist. Either serve with `node:http` + a WebSocket library (works in
   both), or make `manage` require Bun with a clear error. Assets: embedded in the binary, shipped as
   files in the npm package, behind one asset-provider interface.
6. **Reference project** — resolved. Newest Lit repos: `de@estino.de/ui` (2026-10-01, owns the base
   element, Web Awesome Pro 3.13.0 as local workspace package), `daimlertruck-elektrotrucker`
   (2026-08-27, consumer), `david@kvlm.de/projector` (2026-09-08, plain Lit + vite, no WA).
   - Base element (`@optiscaners/ui.components/utils/base.utils.ts`):
     `class EstinoElement extends LitElement { static styles = [baseStyles];
static withStyles<T>(this: T, ...additional: CSSResultGroup[]): T }` → subclass with
     `[Base.styles, ...additional]`. **There is no `withGlobalStyles` anywhere in `~/Projects`.**
     Global-ish styles come from the base stylesheet `base.utils.css`, which `@import`s WA
     `utilities.css` into _every_ shadow root; the page stylesheet `global.css` imports the WA theme
     `styles/themes/default.css`, fonts and `base.utils.css`. For bumper: `BumperElement.withStyles()`
     as above, plus an explicit opt-in (e.g. `BumperElement.withUtilities().withStyles(styles)`) that
     adds WA `utilities.css` to the shadow styles only where utility classes are used.
   - Tooling (elektrotrucker): bun, `vite build --config .configs/vite.config.ts`,
     `vite-plugin-lit-css` (`.css` imports become `CSSResult`; global stylesheets listed in `exclude`),
     `vite-plugin-static-copy`, `resolve.dedupe` for lit; `index.html` under `src/client`, Bun
     middleware under `src/server`, dev proxy `^/api/` → same client+server shape as `manage`.
     `tsconfig`: `@tsconfig/strictest`, `experimentalDecorators: true`,
     `useDefineForClassFields: false`, `module: preserve`, `moduleResolution: bundler`,
     `ts-lit-plugin`. Lint: `eslint.config.ts` = `defineConfig([...config,
setTsConfigRootDir(import.meta.dirname)])` from `@enke.dev/lint/eslint.config.js`; prettier
     re-exports `@enke.dev/lint/prettier.config.js` (+ `@awmottaz/prettier-plugin-void-html`).
     bumper itself uses the `@enke.dev/lint/eslint/presets/node-library` preset; lint 0.13.15 also
     ships `presets/frontend`, `presets/bun-library` and `eslint/{lit,html,json}` configs → use
     `frontend` for `packages/ui`.
   - Web Awesome loading: per-component imports (`dist/components/<name>/<name>.js`), theme
     `dist/styles/themes/default.css` once globally, `dist/styles/utilities.css` (+ `native.css` in
     the preview). Free `@awesome.me/webawesome@3.14.0` (tarball checked) ships
     `dist/styles/{layers,native,utilities,webawesome}.css`, `themes/{default,awesome,shoelace}.css`
     and the components the plan needs (`tree`, `tree-item`, `split-panel`, `drawer`, `checkbox`,
     `badge`, `spinner`, `tab-group`, `details`, `select`, `input`, `switch`, `callout`, `tag`,
     `button`, `icon`). Icons: ui registers a CDN library via `registerIconLibrary`; the free
     default also resolves icons from a CDN → for a local tool, register a small bundled icon set
     (Phase 4 decision).
7. **Repo inventory** — `~/Projects` is nested `<owner>/<repo>`, so the scanner must walk
   recursively and stop at `.git` (not list the entry path's children). 60 git repos, 48 with
   `package.json`: bun 17, pnpm 16, npm 14, yarn 1. Producers with consumers in the folder:
   `@enke.dev/{lint,lit-utils,logbox}`, `@optiscaners/{ui.assets,ui.components,service-kit,
firmware-schemas}`, `eslint-plugin-wc`, `eslint-plugin-playwright`, `@awesome.me/webawesome`
   (fork). Stages (edge = dependency matches a non-private package of another repo):
   - 0: eslint-plugin-playwright, eslint-plugin-wc, webawesome (all forks)
   - 1: lint, zui-web-zalari
   - 2: bumper, lit-utils, logbox, service-kit, pricelist, projector, astro-decap-collection,
     live-protocol, zui-web, zui-angular-example, zui-react-example, zui-web-project-page
   - 3: ui, devkit, kit4, kvlm/website, device-history-service, webdmx
   - 4: pitstop, firmware-schemas, elektrotrucker, estino-keycloak, bakers-wife, simulation,
     tutorials
   - 5: directus-firmware-release-service
   - 16 repos without edges; no cycles.
     Caveats for the graph: forks create false upstream edges → manage needs a per-repo "ignore";
     `zui-web` and `zui-web-zalari` publish identical names → ambiguous producer = diagnostic; several
     repos lack `private: true` but never publish (knowledge, fleetmanagement-mesh-hive-gateway,
     webdmx root, eslint-plugin-playwright `examples`) → only matters when matched as a producer.
     GitHub Packages producers: service-kit, ui, pitstop.{app,bff}, tutorials. pnpm ≥ 11 repos
     (cooldown on by default): estino-keycloak 11.22, firmware-schemas 12.4 (`trustLockfile: true`),
     tutorials 11.18, webdmx 11.22 — all four already carry version-pinned
     `minimumReleaseAgeExclude` entries for `@optiscaners/ui.*`, `@enke.dev/lit-utils`, `logbox`,
     `lint`, i.e. the manual workaround the cascade automates. Bun repos with a cooldown: ui (14400 s),
     kvlm/website (604800 s), Fleet-WebApp (259200 s), name-only excludes incl. `@enke.dev/*`.
     `~/.bumperrc` holds 19+ entries keyed by absolute path (all defaults except bumper's
     `exclude: ["examples"]`) and one stale path (`david@kvlm.de/next`) → show "missing" entries.
8. **Bumper as it is (for Phase 1)** — single package; entry `src/cli.ts`; npm build
   `bun build ./src/cli.ts --target=node --outfile dist/cli.mjs` (`prepare` hook); binaries via
   `scripts/build-binaries.sh` (`bun build --compile --define "__BUMPER_CHANNEL__='binary'"
./src/cli.ts`, 5 targets). Commands: `src/commands/command.registry.ts` (`Command {name, run,
help}`), shared parseArgs `cliOptions` in `command.types.ts`. Modules:
   `src/modules/module.registry.ts` ordered list of `Module {kind, id, title, isUsed, update,
managedDependencies?, managedImages?}`. Context: `buildContext(cwd, {dryRun, exclude,
ignoreConfig, minReleaseAge})` → detectors + `release-age.utils`. Config: `src/config/config.ts`
   (`~/.bumperrc` = `{skipVersionCheck?, repos: {[absPath]: {exclude, modules}}}`, `resolveForPath`
   auto-creates entries). Registry access via `exec` child processes only. Breaks when files move:
   1. `import pkg from '../package.json'` / `'../../../package.json'` in `cli.ts`,
      `update.command.ts`, `version.command.ts`, `upgrade.command.ts` → version must come from
      `packages/cli/package.json`; core must not import a manifest.
   2. `src/testing/with-fixture.harness.ts` resolves `examples/` as `../../examples` from its file.
   3. Scripts: `test:node` glob `src/**/*.spec.ts`, junit paths `reports/junit.*.xml` (CI
      `report_paths`), `prepare` (root `bun install` + npm re-runs it at publish → needed in
      `packages/cli`), `dev`, `build`.
   4. `.release-it.json`: `npm.publish` publishes cwd → set `npm.publishPath: "packages/cli"`
      (release-it 21.1.0 `lib/plugin/npm/npm.js:298`); release-it bumps the root manifest, so the
      CLI manifest version must be synced in a hook; `after:bump` → `scripts/build-binaries.sh`;
      `github.assets: dist/bin/bmpr-*`.
   5. Workflows: `preview.yml` runs `npm version … --no-git-tag-version` at root (must target the
      CLI package); `production.yml` writes `.npmrc` at root (fine with publishPath, npm reads the
      project `.npmrc` from cwd); `bun-version-file: package.json` stays root.
   6. `action.yml` (`bunx @enke.dev/bumper update …`) and `install.sh` (assets `bmpr-<os>-<arch>`)
      are layout-independent; `self-upgrade.utils.ts` mirrors the asset names.
   7. `tsconfig.json` `include: ["src/**/*.ts", …]`, `types: ["bun"]`; `eslint.config.ts` ignores
      `examples/**`; `.prettierignore` lists `examples/**`, `assets`.
   8. `files`: `dist/cli.mjs`, `assets/icon/icon.png` → move into `packages/cli`.
   9. `~/.bumperrc` entry for the bumper repo has `exclude: ["examples"]` → adjust if fixtures move.
   10. README dev section (`bun run --bun src/cli.ts …`, `bun link`) and `examples/README.md`.
       Root-level `bunfig.toml` (`exact = true`), `.bun-version`, single `bun.lock` stay.

## Phase 1 — Monorepo restructure (separate release, no behaviour change)

- Bun workspaces: `packages/core` (library, bundled, not published separately),
  `packages/cli` (published as `@enke.dev/bumper`, same `bin` names), `packages/ui` (static build,
  embedded into CLI build and binaries).
- `action.yml` stays at repo root, points at the CLI's new location.
- `install.sh` asset names unchanged; release-it and CI paths adjusted.
- Done when all commands, the GitHub Action and the binaries behave exactly as before.

**Status (2026-10-05): restructured, release pending.** Layout: `packages/core`
(`@enke.dev/bumper-core`, private, source-only, `exports: {"./*.js": "./src/*.ts"}`, holds
`examples/` fixtures) and `packages/cli` (`@enke.dev/bumper`, commands + `cli.ts`, own
`.release-it.json` and `CHANGELOG.md`, binaries in `packages/cli/dist/bin`). release-it runs with
`working-directory: packages/cli` (it reads name/version from its cwd and stages `git add . --update`
there). README/LICENSE are copied into the CLI package by its `prepack` hook (gitignored copies).
`bunfig.toml` pins `linker = "hoisted"`: bun 1.4 defaults workspaces to the isolated linker, which
broke prettier plugin resolution from the root. No `packages/ui` yet; it arrives with Phase 4.

## Phase 2 — Core

- **Config schema:** single definition of `~/.bumperrc` (global `skipVersionCheck`; per repo
  `exclude`, `modules`, plus new `branch`, `checks`, `waitForRelease`). Used by `config get/set`
  and the UI form.
- **Workspace scan** and **graph** (stages, cycles → diagnostics).
- **Runner** per repo, every transition emitted as an event:
  queued → preparing (clean tree, fetch, `pull --ff-only`) → updating (`update -afc` as child
  process, `FORCE_COLOR=1`) → checking (configured commands in order) → pushing (configured branch)
  → awaiting release (optional) → done | failed | blocked | skipped.
- **Scheduler:** stage-parallel; failure blocks dependents; Retry / Run anyway / Skip waiting.
- **Release wait:** snapshot version lists before push, poll with backoff, timeout, skip.

**Status (2026-10-05): done in `packages/core/src/manage/`** — `scan.ts` (recursive repo walk, stops at
`.git`, yarn/no-manifest = unsupported), `graph.ts` (producers, Kahn stages, Tarjan cycles, ambiguous
producers), `diagnostics.ts` (collector list: unsupported, no-checks, graph-cycle, ambiguous-producer,
branch-switch, dirty-tree, behind-remote, registry-auth), `runner.ts` (`RepoRun`, injectable deps,
`--allow-young` from upstream producers, timeout on the release wait = failed), `scheduler.ts`
(readiness by selected upstreams instead of a stage barrier; same result, more parallelism),
`release-wait.ts`, `exec-stream.ts`. Config schema in `config/config.schema.ts` drives `config set`.
`update --allow-young <pkg>` implements decision 1.1 (pnpm pinned rule + prune, bun ungated install).

## Phase 3 — Server (`bmpr manage [path]`)

- Bun only (see Decisions). `Bun.serve` on 127.0.0.1, random port, opens the browser.
- Random session token in the URL (prevents other sites from driving the local API).
- `GET /api/workspace`, `GET`/`PUT /api/config`, `POST /api/run`, per-repo retry/continue/skip,
  WebSocket for status events and repo-tagged log lines.
- Capped in-memory log per repo (replay on selection). The run belongs to the server process;
  browser reloads don't stop it.

**Status (2026-10-05): done.** `packages/cli/src/commands/manage/`: `manage.command.ts` (Bun guard, default
root `~/Projects`, `--port`, `--no-open`, opens the browser), `manage.server.ts` (`Bun.serve`, token in
query or `x-bumper-token` header, routes `GET /api/workspace`, `POST /api/workspace/rescan`, `GET|PUT
/api/config`, `PUT /api/config/repos/<id>`, `GET|POST /api/run`, `POST /api/run/<id>/{retry,run-anyway,
skip-waiting}`, `GET /api/logs/<id>`, `GET /ws`). **Assets:** instead of an asset provider, the UI is one
self-contained `packages/ui/dist/index.html` (vite flat build + `scripts/inline.ts`) imported by the CLI
with `import … with { type: text }` — verified inlined by `bun build --target=node`, `--compile` and
`bun run`. Dev: `bun run dev:manage` (port 3131) + `bun run dev:ui` (vite proxies `/api` and `/ws`).

## Phase 4 — UI (Lit + Web Awesome, minimal local styles)

All components extend `BumperElement`, opting into global styles only where needed.

- `bumper-app`: two-panel layout (`wa-split-panel`), run bar with Update and run options
  ("Ignore minimum release age").
- `bumper-repo-list`: `wa-tree`, stage groups → repo items; own checkbox per item; status
  (spinner/icon/badge); "upstream changes" badge; diagnostics indicator; "select with dependents".
- `bumper-log-view`: selected repo's output, ANSI → HTML.
- `bumper-repo-settings`: `wa-drawer` with a schema-driven form, branch picker (custom + existing),
  check-command editor.
- One store fed by the WebSocket, shared via Lit context.
  **Status (2026-10-05): done** (`packages/ui/src/`). `utils/base.utils.ts`: `BumperElement.withStyles()` +
  `withUtilities()` (opt-in Web Awesome utility classes per shadow root). `state/store.ts`: `ManageStore` +
  `StoreController` + `storeContext`; `api/client.ts` (token from the URL, reconnecting WebSocket).
  Components: `bumper-app` (header run bar, `wa-split-panel`, error callout), `bumper-repo-list` (`wa-tree
selection="single"`, slotted `wa-checkbox`, status badge/spinner, "upstream changes", diagnostics tag with
  tooltip, select-with-dependents, settings), `bumper-log-view` (ANSI spans, retry / run anyway / skip
  waiting, diagnostics list), `bumper-repo-settings` (`wa-drawer`, form from `REPO_CONFIG_FIELDS`: branch
  picker with "current"/"custom…"/local branches, checks textarea, wait switch, module tri-state selects,
  global `skipVersionCheck`). Icons: Web Awesome's bundled `system` library only, so the GUI works offline.
  Verified headless (playwright): renders 11 repos / 3 stages, no console errors.

## Phase 5 — Tests and docs

- Core tests for graph, scheduler, state machine with fake process/registry adapters.
- One end-to-end run against fixture repos and a local registry (e.g. verdaccio).
- README section for `manage`.
  **Status (2026-10-05): done, with one deviation.** Core specs: graph, scheduler, runner (fake
  adapters), release wait, scan, diagnostics, session, config schema, exclude-rule YAML, allow-young.
  End-to-end: `manage/runner.e2e.spec.ts` runs the real `RepoRun` with real git (bare origin + clone), a
  stand-in `bumper` script and a fake registry lookup — prepare, update, check, push to a new branch,
  release wait. **No verdaccio:** the registry side is covered by the fake lookup and the `view` helpers'
  unit tests; a local registry would only re-test `npm view`. README gained a Manage section,
  `--allow-young` and the new `~/.bumperrc` keys. 339 tests on bun and node.

## Follow-ups (2026-10-05, after v0.14.0)

- **Lazy diagnostics:** scan runs `FAST_COLLECTORS` only; `SLOW_COLLECTORS` (dirty tree, behind
  remote, registry auth) run per repo via `ManageSession.diagnose(id)` / `POST /api/workspace/<id>/
diagnose`, triggered by the GUI on first focus and by the "Check / Re-check" button. Result arrives
  as a `diagnostics` event; `RepoView.diagnosed` tells whether it ran.
- **Forks:** `RepoInfo.fork` — the manifest `repository` (root first, then workspace members) names a
  different GitHub owner/name than `origin`. Forks never produce graph edges; `fork` info diagnostic.
  Detected locally: webawesome, eslint-plugin-wc, eslint-plugin-playwright.
- **Symlinks:** `findRepos` follows symlinked directories (`stat`), deduplicated by `realpath`, so
  loops and double-reachable repos are safe.

## Out of scope

GitHub workflow-run polling; yarn (arrives via core).
