#!/usr/bin/env bash
#
# Optional Unix convenience installer for the cockpit statusline.
#
# Points the USER-scope ~/.claude/settings.json statusLine.command at this repo's
# statusline-render.js. Writes a timestamped backup before touching anything, and
# is idempotent: if statusLine.command already points at the cockpit renderer it
# does nothing (so a re-run can't back up an already-modified file). A DIFFERENT
# existing statusLine is warned about as it is replaced (Claude Code has a single
# statusline slot).
#
# Edits ~/.claude/settings.json (user scope) ONLY — never a project/.claude one.
# Windows users: follow the manual JSON edit in README.md instead.
#
# NOTE: we write the ABSOLUTE renderer path, not ${CLAUDE_PLUGIN_ROOT}, because
# statusLine.command does not support that variable (see README.md).
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RENDERER="$SCRIPT_DIR/statusline-render.js"
SETTINGS="$HOME/.claude/settings.json"
COMMAND="node \"$RENDERER\""

if [ ! -f "$RENDERER" ]; then
  echo "error: renderer not found at $RENDERER" >&2
  exit 1
fi

# node is required both to run the statusline and to edit the JSON safely here.
if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' is not on PATH; the statusline needs Node.js to run." >&2
  exit 1
fi

# Ensure the settings file exists; remember whether it pre-existed so we only
# back up real user content (a freshly-created {} has nothing to preserve).
PREEXISTED=1
if [ ! -f "$SETTINGS" ]; then
  PREEXISTED=0
  mkdir -p "$(dirname "$SETTINGS")"
  printf '%s\n' '{}' > "$SETTINGS"
fi

# Current statusLine.command (empty if unset or the file is unparseable).
CURRENT="$(node -e '
  try {
    var fs = require("fs");
    var s = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "{}");
    process.stdout.write((s && s.statusLine && s.statusLine.command) || "");
  } catch (e) { process.stdout.write(""); }
' "$SETTINGS")"

if [ "$CURRENT" = "$COMMAND" ]; then
  echo "Cockpit statusline already installed — nothing to do."
  echo "  statusLine.command = $COMMAND"
  exit 0
fi

# Decide the message; the "statusline/statusline-render.js" marker means a cockpit
# renderer at a different path (e.g. the repo moved), i.e. an update, not a foreign
# statusline being replaced.
case "$CURRENT" in
  *statusline/statusline-render.js*)
    echo "Updating cockpit statusline path -> $RENDERER" ;;
  "")
    echo "Installing cockpit statusline." ;;
  *)
    echo "warning: replacing your existing statusLine.command:" >&2
    echo "  $CURRENT" >&2 ;;
esac

# Timestamped backup before any modification (only if there was user content).
if [ "$PREEXISTED" -eq 1 ]; then
  BACKUP="$SETTINGS.backup-$(date +%Y%m%d-%H%M%S)"
  cp "$SETTINGS" "$BACKUP"
  echo "Backup written to $BACKUP"
fi

# Set statusLine.type/command, preserving any other statusLine sub-keys (padding,
# refreshInterval, …) and every other top-level setting.
node -e '
  var fs = require("fs");
  var f = process.argv[1], cmd = process.argv[2];
  var s = {};
  try { s = JSON.parse(fs.readFileSync(f, "utf8") || "{}"); } catch (e) { s = {}; }
  if (!s || typeof s !== "object" || Array.isArray(s)) s = {};
  var sl = (s.statusLine && typeof s.statusLine === "object" && !Array.isArray(s.statusLine)) ? s.statusLine : {};
  sl.type = "command";
  sl.command = cmd;
  s.statusLine = sl;
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
' "$SETTINGS" "$COMMAND"

echo "Done. statusLine.command -> $COMMAND"
echo "Open the dashboard (/cockpit:open) to see the live usage bars."
if [ "$PREEXISTED" -eq 1 ]; then
  echo "Revert by restoring $BACKUP (or removing the statusLine key)."
else
  echo "Revert by removing the statusLine key from $SETTINGS."
fi
