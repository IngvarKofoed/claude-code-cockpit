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

## Install (all platforms)

Run the installer from the repo root:

```sh
node statusline/install.js
```

That is the whole thing on every OS. It edits your **user-scope**
`~/.claude/settings.json`, writes a timestamped backup first, preserves your
other settings, and is idempotent (a re-run when it's already installed is a
no-op). If a *different* `statusLine` is already configured it warns you that
it's being replaced — Claude Code has a single statusline slot. It refuses to
touch a `settings.json` that isn't valid JSON rather than overwriting it.

**Restart Claude Code** afterwards for the statusline to take effect.

Four thin wrappers exist for whichever shell you're in; all four just call
`install.js`, so they behave identically:

| Wrapper | Run it with |
| --- | --- |
| `install.sh` | `sh statusline/install.sh` |
| `install.cmd` | `statusline\install.cmd` |
| `install.bat` | `statusline\install.bat` |
| `install.ps1` | `powershell -ExecutionPolicy Bypass -File statusline\install.ps1` |

`install.cmd` and `install.bat` are byte-identical — `cmd.exe` treats the two
extensions the same, but which one people reach for differs. The
`-ExecutionPolicy Bypass` on the PowerShell one avoids Windows' default block on
unsigned scripts; the `.cmd`/`.bat` wrappers sidestep script policy entirely.

## Install (manual)

If you'd rather not run a script, `statusLine.command` is just a shell command
Claude Code runs after each assistant message. Point it at this renderer in your
**user settings** (`~/.claude/settings.json`) by hand:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/claude-code-cockpit/statusline/statusline-render.js\""
  }
}
```

Use the **absolute path** to this file. `node` must be on your `PATH` (it already
is if you use this plugin). This works on macOS, Linux, and Windows. The
installer above writes exactly this, computing the path from its own location —
the two produce the same result.

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
