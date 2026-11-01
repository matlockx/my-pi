#!/usr/bin/env bash
# Installs the ub-mode quality-gate tools: crapper, dryer, mutator (unclebob).
# Each tool gets its own uv-managed environment on Python 3.12 (the tools need
# >= 3.11; macOS python3 is 3.9). Executables land in ~/bin, which is on PATH.
# Re-running reinstalls from the current upstream main.
# provides: crapper dryer mutator
set -euo pipefail

command -v uv >/dev/null || { echo "uv is required: brew install uv" >&2; exit 1; }

export UV_TOOL_BIN_DIR="$HOME/bin"
mkdir -p "$UV_TOOL_BIN_DIR"

uv tool install --force --python 3.12 git+https://github.com/unclebob/crapper
uv tool install --force --python 3.12 git+https://github.com/unclebob/dryer
# mutator imports crapper for function names; install it into mutator's environment too.
uv tool install --force --python 3.12 \
  --with git+https://github.com/unclebob/crapper \
  git+https://github.com/unclebob/mutator

for tool in crapper dryer mutator; do
  path=$(command -v "$tool") || { echo "$tool not on PATH" >&2; exit 1; }
  echo "$tool -> $path"
  "$tool" --help >/dev/null
done
echo "ub-mode tools installed."
