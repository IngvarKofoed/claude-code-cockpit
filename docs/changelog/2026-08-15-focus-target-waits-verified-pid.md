# Windows focus resolution waits for the verified owner pid

Windows focus-target resolution now waits for the verified pid (v0.38.0, review fix). It ran on
SessionStart against the per-hook shell pid — already dead, so guaranteed to fail — and
`focusAttempted` latched that miss permanently, so the real pid arriving ~200ms later was never
tried. The `pid:` fallback (VS Code integrated terminals) could therefore never resolve mid-session.
Also saves one doomed PowerShell start-up per Windows session.

<!-- entry 110 -->
