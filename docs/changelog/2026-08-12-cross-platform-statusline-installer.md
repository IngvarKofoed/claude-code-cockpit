# Statusline installer becomes a cross-platform Node script

The statusline installer is now cross-platform `statusline/install.js`; `install.sh` plus new
`.ps1`/`.cmd`/`.bat` are thin wrappers that exec it. Windows previously had no installer at all.
Logic sits in Node because the bash version already shelled out to node for the JSON edit — one
implementation replaces two rather than adding a second to keep in sync.
It writes the renderer path with FORWARD slashes on every platform: Claude Code runs
`statusLine.command` through a shell, and Git Bash silently eats unquoted backslashes.

<!-- entry 98 -->
