# @enke.dev/bumper

## [0.5.1](https://github.com/enke-dev/bumper/compare/0.5.0...0.5.1) (2026-07-21)


### Bug Fixes

* **gh:** drop ${{ secrets }} expression from input description ([56bc561](https://github.com/enke-dev/bumper/commit/56bc5613cc6664db48817f98e83f987dd9d1dcf7))

# [0.5.0](https://github.com/enke-dev/bumper/compare/0.4.12...0.5.0) (2026-07-21)


### Features

* **gh:** optional private-registry auth for the reinstall ([bdc0761](https://github.com/enke-dev/bumper/commit/bdc0761627cdee49cbf94e0af4c6e5ea47249985))

## [0.4.12](https://github.com/enke-dev/bumper/compare/0.4.11...0.4.12) (2026-07-20)


### Bug Fixes

* run the reinstall with --ignore-scripts ([da943d8](https://github.com/enke-dev/bumper/commit/da943d8e585851ec70a23d21e60e9eb69604aa04))

## [0.4.11](https://github.com/enke-dev/bumper/compare/0.4.10...0.4.11) (2026-07-20)


### Bug Fixes

* **gh:** drop --bun so spawned package managers run under real Node ([0df77dd](https://github.com/enke-dev/bumper/commit/0df77dd6995f9fb9d6019cfd4316cb758c893ffb))

## [0.4.10](https://github.com/enke-dev/bumper/compare/0.4.9...0.4.10) (2026-07-20)


### Bug Fixes

* **gh:** persist COREPACK_ENABLE_DOWNLOAD_PROMPT to later steps ([6d7bda7](https://github.com/enke-dev/bumper/commit/6d7bda7b9e4b1985bacd048185fc9c1a5358ec80))

## [0.4.9](https://github.com/enke-dev/bumper/compare/0.4.8...0.4.9) (2026-07-20)


### Bug Fixes

* **gh:** actually provision pnpm/yarn via Corepack in CI ([7c18b67](https://github.com/enke-dev/bumper/commit/7c18b678cf462915c17b0b30379bb789a4369cc6))

## [0.4.8](https://github.com/enke-dev/bumper/compare/0.4.7...0.4.8) (2026-07-20)


### Bug Fixes

* **gh:** set up Node + Corepack so pnpm/yarn repos work ([a952621](https://github.com/enke-dev/bumper/commit/a952621ba7a9b86bf783e46b108b7477f8e78913))

## [0.4.7](https://github.com/enke-dev/bumper/compare/0.4.6...0.4.7) (2026-07-20)

## [0.4.6](https://github.com/enke-dev/bumper/compare/0.4.5...0.4.6) (2026-07-20)

## [0.4.5](https://github.com/enke-dev/bumper/compare/0.4.4...0.4.5) (2026-07-20)

## [0.4.4](https://github.com/enke-dev/bumper/compare/0.4.3...0.4.4) (2026-07-20)

## [0.4.3](https://github.com/enke-dev/bumper/compare/0.4.2...0.4.3) (2026-07-20)


### Bug Fixes

* **gh:** surface the "Actions can't create PRs" setting clearly ([a74fd7f](https://github.com/enke-dev/bumper/commit/a74fd7f2b140e5db200041349625b44644bcee09))

## [0.4.2](https://github.com/enke-dev/bumper/compare/0.4.1...0.4.2) (2026-07-20)


### Bug Fixes

* **gh:** don't let a missing PR label abort the run ([7267617](https://github.com/enke-dev/bumper/commit/72676176da34dfd3fee076667f18364241dba006))

## [0.4.1](https://github.com/enke-dev/bumper/compare/0.4.0...0.4.1) (2026-07-20)


### Bug Fixes

* **gha:** correct setup-bun pin in the composite action ([d837b36](https://github.com/enke-dev/bumper/commit/d837b36bdb6293c015a742418c54234901e923fe))

# [0.4.0](https://github.com/enke-dev/bumper/compare/0.3.0...0.4.0) (2026-07-20)


### Features

* **gh:** add reusable bumper update action and README docs ([c36f4b2](https://github.com/enke-dev/bumper/commit/c36f4b21c4d8177c318995fbe03f1dcedfc53b6e))

# [0.3.0](https://github.com/enke-dev/bumper/compare/0.2.0...0.3.0) (2026-07-18)


### Features

* **cli:** add -e shorthand for --exclude ([a87288d](https://github.com/enke-dev/bumper/commit/a87288d7ed224e89f0af50070eba11bf280787e9))
* **update:** --commit to commit the run with a summary ([4802209](https://github.com/enke-dev/bumper/commit/4802209e820621fc44a6b0fa6d1eb4bccd2ea2cc))

# [0.2.0](https://github.com/enke-dev/bumper/compare/0.1.1...0.2.0) (2026-07-18)


### Features

* **cli:** print version banner on every run ([b175e9b](https://github.com/enke-dev/bumper/commit/b175e9bfbf4cf4961910489cfa9bd7ffffc3cb04))
* **update:** hint when a newer bumper is published ([ddb234c](https://github.com/enke-dev/bumper/commit/ddb234c0ea23a09324a0138bbd4dba7607bd3ff0))

## [0.1.1](https://github.com/enke-dev/bumper/compare/0.1.0...0.1.1) (2026-07-18)

# [0.1.0](https://github.com/enke-dev/bumper/compare/0.0.10...0.1.0) (2026-07-18)


### Bug Fixes

* **detect:** honor --exclude and mark exclude provenance ([f3fdbbd](https://github.com/enke-dev/bumper/commit/f3fdbbde9d00ed29b0197617074d66f307aa7811))


### Features

* **cli:** add --ignore-config flag ([56f2631](https://github.com/enke-dev/bumper/commit/56f26314cee6a9768c826cdf4e8d9a6cad940620))
* **detect:** surface config-driven module + exclude state ([e11c878](https://github.com/enke-dev/bumper/commit/e11c8781a1965331b848a558b9a6de0aaaca89b0))

## [0.0.10](https://github.com/enke-dev/bumper/compare/0.0.9...0.0.10) (2026-07-18)


### Bug Fixes

* make clean install idempotent ([17bafed](https://github.com/enke-dev/bumper/commit/17bafed796a10c8a2e2f4b4fde5cc8786e2c8600))

## [0.0.9](https://github.com/enke-dev/bumper/compare/0.0.8...0.0.9) (2026-07-13)


### Bug Fixes

* never downgrade a pin ([67204d4](https://github.com/enke-dev/bumper/commit/67204d4e5543bef5578a8ee875e466d1278926c0))

## [0.0.8](https://github.com/enke-dev/bumper/compare/0.0.7...0.0.8) (2026-07-13)


### Bug Fixes

* never downgrade a pinned prerelease ([76a8673](https://github.com/enke-dev/bumper/commit/76a86739ef82ff790b31352688f5c57ece90c6d9))
* skip git-ignored workspace members ([e348125](https://github.com/enke-dev/bumper/commit/e348125881785997ae0d5a4c681ef6812f0b383b))

## [0.0.7](https://github.com/enke-dev/bumper/compare/0.0.6...0.0.7) (2026-07-13)


### Bug Fixes

* align peer dep resolution order ([c5ed8b6](https://github.com/enke-dev/bumper/commit/c5ed8b6f03c0ac0140cdb04fefe774a4165d3450))

## [0.0.6](https://github.com/enke-dev/bumper/compare/0.0.5...0.0.6) (2026-07-13)


### Bug Fixes

* remove stale lock files before update ([3698d3e](https://github.com/enke-dev/bumper/commit/3698d3e8c49975ddb2790e801de18d1d0844bdda))

## [0.0.5](https://github.com/enke-dev/bumper/compare/0.0.4...0.0.5) (2026-07-13)


### Bug Fixes

* resolve peer deps post update ([1374bac](https://github.com/enke-dev/bumper/commit/1374bacd37b0889e0fb0a46cee71a9bfb79b6fb8))

## [0.0.4](https://github.com/enke-dev/bumper/compare/0.0.3...0.0.4) (2026-07-13)


### Bug Fixes

* ignore change log in linter ([f4f31ac](https://github.com/enke-dev/bumper/commit/f4f31ac91b9478ff33851d339ed14bcb72924fb5))
* self update npm only to node lts ([8af50e5](https://github.com/enke-dev/bumper/commit/8af50e517ea6787f5bff65e08886e5e40d93b067))

## [0.0.3](https://github.com/enke-dev/bumper/compare/0.0.2...0.0.3) (2026-07-13)


### Bug Fixes

* pin node types ([5c0ee61](https://github.com/enke-dev/bumper/commit/5c0ee61761ab20da2f66e48ea0f7378d7e0be079))

## [0.0.2](https://github.com/enke-dev/bumper/compare/0.0.1...0.0.2) (2026-07-13)

## 0.0.1 (2026-07-13)
