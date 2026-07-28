#!/usr/bin/env bash
#
# Thin wrapper — the installer itself is install.js, which is cross-platform.
# Kept so the documented `sh statusline/install.sh` still works on macOS/Linux.
# See install.js for what it does and why.
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' is not on PATH; the statusline needs Node.js to run." >&2
  exit 1
fi

exec node "$DIR/install.js" "$@"
