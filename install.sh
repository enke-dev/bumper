#!/bin/sh
# Install the latest bumper self-contained binary (bun runtime embedded — no Node needed).
#
#   curl -fsSL https://raw.githubusercontent.com/enke-dev/bumper/main/install.sh | sh
#
# Override the install dir with BUMPER_INSTALL_DIR (default: ~/.local/bin).
set -eu

repo="enke-dev/bumper"
bin="bmpr"
dest="${BUMPER_INSTALL_DIR:-$HOME/.local/bin}"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) echo "bumper: no binary for OS '$os' — try 'npm i -g @enke.dev/bumper'" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) echo "bumper: no binary for arch '$arch' — try 'npm i -g @enke.dev/bumper'" >&2; exit 1 ;;
esac

asset="bmpr-${os}-${arch}"
url="https://github.com/${repo}/releases/latest/download/${asset}"

mkdir -p "$dest"
echo "bumper: downloading ${asset}…"
if ! curl -fsSL "$url" -o "${dest}/${bin}"; then
  echo "bumper: download failed from ${url}" >&2
  exit 1
fi
chmod +x "${dest}/${bin}"
echo "bumper: installed ${bin} to ${dest}"

# Nudge if the install dir isn't on PATH.
case ":${PATH}:" in
  *":${dest}:"*) ;;
  *) echo "bumper: add ${dest} to your PATH, e.g. 'export PATH=\"${dest}:\$PATH\"'" >&2 ;;
esac
