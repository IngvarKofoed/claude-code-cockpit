# Terminal focus now works on Windows via ancestor walk

Focusing a session's terminal now works on WINDOWS too (v0.36.0): the daemon walks the
`Win32_Process` parent chain to the first ancestor owning a window, then raises it
(SetForegroundWindow, AppActivate fallback). WINDOW-level only — Windows Terminal keeps
every tab in one window and exposes no way to select a tab by pid, so a wt.exe session
lands on the last-active tab; legacy conhost (cmd.exe, standalone pwsh) focuses exactly.

<!-- entry 93 -->
