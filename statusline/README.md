# Cockpit statusline

A colored one-line Claude Code [statusline](https://code.claude.com/docs/en/statusline)
that also feeds the cockpit dashboard. It renders directly in your terminal after
each assistant message and, best-effort, forwards Anthropic's rate-limit numbers
to the daemon so the Live page can draw the session-5h and weekly usage bars.

## What it shows

A single colored line, segments separated by ` · `:

| Segment | Colour | Meaning |
| --- | --- | --- |
| model | cyan | Active model display name |
| repo | bright yellow | Current directory basename |
| branch | bright blue | Git branch (`⎇`), from the payload or a quick `git` fallback |
| tokens | pink | Tokens in the context window (input + output) |
| cost | green | Session cost estimate (`$`) reported by Claude Code |
| active | white | Session duration (`⧗`) |
| ctx-bar | threshold | Context-window used %, as a bar + label |
| 5h-bar | threshold | 5-hour rate-limit used %, as a bar + label, with reset time (`↻`) |

Bar/label colour follows the usual convention: green below 50%, amber below 80%,
red at 80% or more; gray when the value is unknown (shown as `—`, never a wrong 0).

The 5h bar only appears for Claude.ai (Pro/Max) subscribers, and only after the
first API response of a session — API-key users won't see it (and nothing is
forwarded to the dashboard in that case).

## What it forwards to the dashboard

After printing the line, the renderer POSTs **only** the payload's `rate_limits`
(the 5-hour and 7-day used-percentage + reset times) to the daemon's
`/internal/usage`, authenticated with the same bearer token the hooks use. That
is the only local carrier of Anthropic's real rate-limit numbers, so **installing
this statusline is what lights up the Live page's usage bars.** Nothing else from
the payload (cwd, cost, model, session id) is sent or stored — the forward is
stripped to `rate_limits` for privacy. The POST is fire-and-forget on a ~150 ms
budget and can never delay the rendered line or fail your session.

## Install (all platforms — the primary path)

Claude Code's `statusLine.command` runs a shell command after each assistant
message. Point it at this renderer in your **user settings** (`~/.claude/settings.json`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/claude-code-cockpit/statusline/statusline-render.js\""
  }
}
```

Use the **absolute path** to this file. `node` must be on your `PATH` (it already
is if you use this plugin). This works on macOS, Linux, and Windows.

> **This replaces any existing `statusLine`.** Claude Code has a single statusline
> slot. To revert, restore your settings backup or remove the `statusLine` key.

> **Windows:** write the path with **forward slashes** (`C:/Users/you/...`), never
> backslashes. Claude Code runs the command through Git Bash (or PowerShell), and
> Git Bash silently drops unquoted backslashes. `~` also works.

### Why not `${CLAUDE_PLUGIN_ROOT}`?

Hooks can use `${CLAUDE_PLUGIN_ROOT}` so their command survives a plugin upgrade
moving the install dir — but **`statusLine.command` does not support it.** Per the
Claude Code docs, path variables like `${CLAUDE_PLUGIN_ROOT}` are only substituted
in skill/agent/hook/monitor/MCP/LSP configs and only exported to hook and MCP/LSP
processes — the statusline is not in either list, so it would expand to an empty
string and break the command. Use the absolute path instead. If you install this
plugin from a marketplace (rather than a local clone), point the command at the
plugin's install directory; **re-point it after a plugin upgrade**, since that
directory can change (the old one is garbage-collected roughly a week later).

## Install (Unix convenience)

On macOS/Linux you can run the bundled installer, which edits your **user-scope**
`~/.claude/settings.json`, writes a timestamped backup first, and is idempotent
(re-running when it's already installed is a no-op):

```sh
sh statusline/install.sh
```

It computes the absolute renderer path from its own location. If a *different*
`statusLine` is already configured, it warns you that it's being replaced. Windows
users should use the manual JSON edit above.
