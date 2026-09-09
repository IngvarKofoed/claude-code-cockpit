# Tabby closes every Windows focus join key

Tabby closes every join key the other Windows paths use (v0.41.0), measured: UIA exposes ONE
Pane (no Chromium a11y tree, so no TabItem to select), and the process ancestry is SEVERED — the
npm `claude` shim runs via an `sh.exe` whose parent has already exited, so 4/4 live sessions walk
to a dead pid and Tabby.exe is never an ancestor. Do not re-attempt UIA or traversal for it.

<!-- entry 126 -->
