#!/usr/bin/env bash
# Installs the ub-mode quality-gate tools.
#   crapper - CRAP score per function (SKILL.md "Crapper" gate).
#             https://github.com/unclebob/crapper
#   dryer   - structural duplicate finder (SKILL.md "Dryer" gate).
#             https://github.com/unclebob/dryer
#   mutator - mutation testing (SKILL.md "Mutator" gate). Imports the crapper
#             package (mutator/crapper_link.py), so crapper is installed into
#             mutator's environment too; no ../crapper checkout is needed.
#             https://github.com/unclebob/mutator
# Each tool gets its own uv-managed environment on Python 3.12 (the tools need
# >= 3.11; macOS python3 is 3.9). Commands are linked into ~/bin, which is on
# PATH. Tools already on PATH are skipped.
# provides: crapper dryer mutator
set -euo pipefail

command -v uv >/dev/null || { echo "uv is required: brew install uv" >&2; exit 1; }

export UV_TOOL_BIN_DIR="$HOME/bin"
mkdir -p "$UV_TOOL_BIN_DIR"
case ":$PATH:" in
  *":$UV_TOOL_BIN_DIR:"*) ;;
  *) echo "Add to PATH (fish): fish_add_path $UV_TOOL_BIN_DIR" >&2 ;;
esac

install_tool() {
  local tool=$1
  shift
  if command -v "$tool" >/dev/null; then
    echo "$tool already present: $(command -v "$tool")"
    return
  fi
  echo "Installing $tool"
  # DEV-NOTE: --force only runs when the command is missing from PATH; it relinks
  # a uv environment that exists without its ~/bin entry.
  uv tool install --force --python 3.12 "$@"
}

install_tool crapper git+https://github.com/unclebob/crapper
install_tool dryer git+https://github.com/unclebob/dryer
install_tool mutator --with git+https://github.com/unclebob/crapper git+https://github.com/unclebob/mutator

status=0
for tool in crapper dryer mutator; do
  if ! path=$(command -v "$tool"); then
    echo "$tool not on PATH" >&2
    status=1
    continue
  fi
  if "$tool" --help >/dev/null; then
    echo "$tool -> $path"
  else
    echo "$tool at $path does not start" >&2
    status=1
  fi
done
exit "$status"
