# Window raise confirmed against GetForegroundWindow, not a return value

The window raise is CONFIRMED against `GetForegroundWindow`, not a return value (v0.41.0) —
in the spirit of entry 106, which confirms only the tab SELECTION. It previously reported `ok` from
`SetForegroundWindow`'s boolean, which is exactly the call that lies here, so a click that
raised nothing still toasted success. `no-window` (no ancestor owns one — every ConPTY client
reports MainWindowHandle = 0) stays distinct from `focus-refused` (it exists, Windows declined).

<!-- entry 124 -->
