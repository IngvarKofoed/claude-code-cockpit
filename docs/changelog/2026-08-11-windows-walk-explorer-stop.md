# Windows ancestor walk stops at explorer.exe

The Windows ancestor walk STOPS at explorer.exe and the session-critical processes
(v0.36.0). Every chain reaches explorer.exe eventually, and its "main window" is the
desktop/taskbar — so a shell reporting no console window of its own (a legacy conhost
window belongs to a conhost.exe CHILD, unreachable by walking up) would have resolved
to the taskbar. Now that case degrades to a hidden button, not a wrong one.
Known limit, matching the macOS tty: a target pid recycled between resolve and click
could raise an unrelated window. Bounded — the host dying reaps the session.

<!-- entry 95 -->
