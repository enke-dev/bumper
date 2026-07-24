#!/bin/sh
# Cross-compile the self-contained bmpr binaries into dist/bin (Bun runtime embedded).
# Run AFTER package.json holds the version being released — the CLI bakes its version in
# at compile time (`import pkg from '../package.json'`), so building before the bump ships
# a binary that reports the wrong version. Assumes bun + deps are already set up.
set -eu

mkdir -p dist/bin
for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64; do
  out="dist/bin/bmpr-${target}"
  [ "$target" = windows-x64 ] && out="${out}.exe"
  echo "compiling ${target}…"
  bun build --compile --target="bun-${target}" ./src/cli.ts --outfile "$out"
done
