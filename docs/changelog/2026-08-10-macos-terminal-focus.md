# Live cards can raise the macOS Terminal window

Live cards can now raise the Terminal window running a session (v0.35.0) — one click on the
card-head glyph, so a "waiting for input" card leads straight to where you answer it.
`POST /api/focus` takes a sessionId and NEVER a terminal: the daemon re-derives the device from
its own state and passes it to osascript via argv, so a page reaching the endpoint still can't
name a window (or a command). macOS Terminal.app only; iTerm2/tmux/VS Code resolve to no match.

<!-- entry 91 -->
