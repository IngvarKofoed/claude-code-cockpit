# claude-code-cockpit

Live, cross-platform **mission control** for every [Claude Code](https://docs.claude.com/claude-code)
session you have running. One dashboard shows which prompts are running, in
which repository, for how long, what Claude is doing right now, and how much
time, how many tokens, and roughly how much money each repository has consumed.

Where a single-session notifier tells you *when one session* needs you, the
cockpit shows you **everything happening across all sessions at once** — plus
per-repository token/time/cost accounting and history.

## How it works

The plugin observes passively through Claude Code hooks. Tiny hook scripts
append events to a durable local log and nudge a small always-on background
**daemon** bound to `127.0.0.1`. The daemon maintains live per-session state and
per-repository rollups, enriches them with token usage parsed from session
transcripts, and serves a buildless single-page dashboard over Server-Sent
Events. Optional OS notifications and sounds are emitted by the daemon, so they
work whether or not a browser tab is open.

## Prerequisites

- **Node.js 18+** on your `PATH` (the same runtime Claude Code plugins use).
- Linux desktop notifications additionally need a working `notify-send`.

The only runtime dependency beyond Node built-ins is
[`node-notifier`](https://www.npmjs.com/package/node-notifier); it is installed
automatically on first `SessionStart` — you do not run `npm install` yourself.

## Install

Install as a Claude Code plugin from its marketplace:

```
/plugin marketplace add IngvarKofoed/claude-code-cockpit
/plugin install cockpit@claude-code-cockpit
```

To install from a local checkout instead, point the marketplace at the repo
directory:

```
/plugin marketplace add /path/to/claude-code-cockpit
/plugin install cockpit@claude-code-cockpit
```

The first time a session starts after installing, the daemon is spawned
automatically and dependencies are installed once.

## Usage

Slash commands (namespace `cockpit`):

- **`/cockpit:open`** — ensure the daemon is up, then open the dashboard in your
  browser (and print the URL). This is also where you change every setting.
- **`/cockpit:status`** — a quick text summary: daemon health, dashboard URL,
  and the count of active sessions.
- **`/cockpit:stop`** — stop the background daemon. It is auto-revived on the
  next session start.

The dashboard's tabs:

- **Live** — one card per active session: repo, branch, status, current
  activity, a ticking prompt timer, tokens, and estimated cost. Sessions
  *waiting for input* sort to the top and are highlighted.
- **Repos** — a sortable table of active time, prompts, sessions, tokens, and
  estimated cost, with a time-range filter.
- **History** — charts of tokens and time per day, activity by hour, and top
  repositories.
- **Settings** — the single place to configure everything (see below).

## Privacy

All data stays on your machine.

- The dashboard binds to `127.0.0.1` only — never `0.0.0.0` — and every endpoint
  requires an unguessable bearer token stored in a `0600` file readable only by
  you.
- **No message content is ever stored or served.** The cockpit records only
  token counts, tool *names*, and metadata — never your prompts, Claude's
  responses, tool inputs, or tool outputs.
- The Live view shows the tool **name** ("Running Bash", "Editing a file") by
  default. Richer tool-argument detail (a truncated file path or command) is a
  separate, **default-off** setting and is shown locally only.
- Dollar figures are **estimates** from a configurable pricing table, not
  authoritative charges.

## Configuration

All configuration is edited in the dashboard's **Settings** view — there is no
setup wizard. Editable settings include the OS-notification master toggle,
OS-sound and in-browser-sound toggles, per-event notifications (session
finished, needs input, long-running prompt, turn failed), the long-running
threshold, the activity-detail level, the pricing table and currency, data
retention, and idle shutdown.

The config file lives at `<configDir>/config.json` and remains hand-editable as
a fallback for headless setups, but the dashboard is the intended editor.

## Data location

Runtime data (event log, token-usage log, daily rollups, snapshot, port/pid
files, daemon log) lives under the platform state directory, and configuration
under the platform config directory:

| Platform      | State directory                                    | Config directory                             |
| ------------- | -------------------------------------------------- | -------------------------------------------- |
| macOS / Linux | `$XDG_STATE_HOME/claude-code-cockpit` or `~/.local/state/claude-code-cockpit` | `$XDG_CONFIG_HOME/claude-code-cockpit` or `~/.config/claude-code-cockpit` |
| Windows       | `%LOCALAPPDATA%\claude-code-cockpit`               | `%APPDATA%\claude-code-cockpit`              |

### Clearing your data

Stop the daemon first with `/cockpit:stop`, then delete the state directory
above (this removes all events, usage, rollups, and the daemon's port/pid/token
files). Delete the config directory too if you also want to reset your settings.
The directories are recreated on the next session start.

## License

See repository.
