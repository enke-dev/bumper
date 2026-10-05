#!/bin/sh
# Cross-compile the self-contained bmpr binaries into packages/cli/dist/bin (Bun runtime embedded).
# Run AFTER packages/cli/package.json holds the version being released — the CLI bakes its version
# in at compile time (`import pkg from '../package.json'`), so building before the bump ships a
# binary that reports the wrong version. Assumes bun + deps are already set up. Works from any cwd
# (release-it calls it from packages/cli).
set -eu

cd "$(dirname "$0")/.."
out_dir="packages/cli/dist/bin"
mkdir -p "$out_dir"
for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64; do
  out="${out_dir}/bmpr-${target}"
  [ "$target" = windows-x64 ] && out="${out}.exe"
  echo "compiling ${target}…"
  bun build --compile --define "__BUMPER_CHANNEL__='binary'" \
    --target="bun-${target}" ./packages/cli/src/cli.ts --outfile "$out"
done
