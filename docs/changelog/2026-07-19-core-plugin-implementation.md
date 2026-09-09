# Full v0.1–v0.3 plugin implementation lands

Full v0.1–v0.3 implementation landed: hook `emit.js`, `ensure`/`ensure-deps`, the always-on `daemon.js`,
the pure core (`aggregate`/`transcript`/`repo`/`pricing`), `config`/`paths`/`notify`, the buildless web SPA
(Live/Per-repo/History/Settings over SSE), the `/cockpit:*` commands, and plugin wiring.
Plugin is named `cockpit` (so commands resolve to `/cockpit:*`); `paths.APP_NAME` stays `claude-code-cockpit`.
82 unit tests pass; daemon verified end-to-end (auth enforced, token ingestion, pricing, restart idempotency).
Confirmed via docs: `StopFailure`/`SubagentStart`/`PostToolUseFailure` are real hooks; `effort.level` is nested;
`Notification` carries `notification_type`; commands namespace off the plugin name.

<!-- entry 3 -->
