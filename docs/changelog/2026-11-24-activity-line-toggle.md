# Live card activity line can be hidden

Settings ▸ Dashboard has a **Show activity line** switch, on by default. Off, every Live card in
this browser drops its "Working…" / status line and spark dot, reclaiming that line's height.
Extends the per-line switches of `2026-08-08-live-card-location-toggles` to the activity line.

## Detail

- **A new `cockpit.liveShow` key has to be added in two places**, as `activity` was: the
  `App.liveShow` default object, because `setLiveShow` ignores a key it doesn't already hold, and
  the `init` load guard, which rebuilds the object key by key (`activity: v.activity !== false`, so
  a value stored before the key existed reads as on). Only the `set-show-*` change handler is
  generic.
- The switch's description says what hiding costs: the line also carries the current tool,
  "Waiting for your input" and a failed turn's reason, which the badge alone doesn't spell out.
- **Verified** in headless Chrome against an isolated test daemon. The line goes on every card and
  stays off after a reload. Toggling sends no request and shows no "Settings saved" toast, because
  it is a per-browser pref, not config.
