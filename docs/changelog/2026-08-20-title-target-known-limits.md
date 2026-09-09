# Title-matched target is window-level and needs dynamic titles

Known limits of that target, both deliberate. It is WINDOW-level, so a session in a BACKGROUND
tab emits no signal at all (no window title, no UIA node) and stays unfocusable — the pre-UIA
Windows Terminal situation, honest but not tab-exact. And Tabby needs `disableDynamicTitle:
false` in its profile: with the default `true` the shell title never reaches the tab or the
window, so there is nothing to match and the button correctly stays hidden.

<!-- entry 129 -->
