# claude-code-cockpit — web (dashboard SPA)

The buildless browser dashboard served by the daemon over `127.0.0.1`. Refer to `docs/ARCHITECTURE.md` for the broader context.

Contents: `index.html` (dashboard shell), `app.js` (loads `GET /api/state`, subscribes to the SSE stream, renders the live cards / per-repo table / Settings), `charts.js` (inline-SVG chart helpers), `styles.css`.

## Required tools

- **`LSP`** — symbol navigation across the SPA's JavaScript modules. If deferred, load via `ToolSearch` with `select:LSP`.
- **Playwright MCP** (browser tools) — required for driving and verifying the dashboard in a real browser (see the verification workflow). Load the core set in one `ToolSearch` call, e.g. `select:mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_console_messages,mcp__playwright__browser_network_requests`.

## Required skills

- **`dataviz`** — you **must** read it before writing or changing **any** chart, KPI/stat tile, color-by-series choice, or dashboard layout. It governs the dashboard's charts (tokens & time per day, activity by hour, top repos) and the per-repo stat tiles.
- **`frontend-design`** — invoke when building or reshaping the dashboard's visual design (layout, typography, overall look) so it reads as intentional rather than templated.

## Testing

Buildless SPA — **no unit-test framework** (no bundler, no CDN, ES modules only). Verification is browser-driven (below). If a unit-test framework is ever introduced, update the architecture doc first.

## Subtree-scoped rules

- **Verification workflow (UI).** For any change to the dashboard:
  1. Ensure the daemon is running and serving the dashboard (e.g. via `/cockpit:open` or launching `daemon.js`); note the `127.0.0.1` URL.
  2. Open it in a real browser via the Playwright MCP tools (`browser_navigate` + `browser_snapshot`) and drive the changed feature — e.g. trigger a session state change and confirm the live card, ticking timer, or chart updates over SSE.
  3. Check console messages and network requests (including the `/api/stream` SSE connection) for errors.
  4. Only then report the change as complete.
- **Self-contained only.** No external assets — no CDN, no bundler, no remote fonts/images. Everything is inline or served locally so the dashboard works offline. (This is an architectural constraint, not a preference.)
- **Never render conversation content.** The dashboard shows counts, tool names, status, and metadata only — never transcript/prompt/response text. This is the project's privacy boundary; keep it.
