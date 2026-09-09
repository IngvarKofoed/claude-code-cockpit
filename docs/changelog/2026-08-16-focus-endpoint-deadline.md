# POST /api/focus bounded to a 12s deadline

`POST /api/focus` has an overall 12s deadline and per-call budgets cut to 8s (v0.38.0, review fix);
the chain could previously run ~35s with the browser fetch open and no toast, so the button just
looked dead and invited re-clicks that each spawned another PowerShell/UIA pair.
The select script also re-checks the tab NAME before selecting: the index came from an earlier
enumeration, so a tab closed or reordered in between meant selecting a different session's tab.
The expected name travels by ENVIRONMENT variable, never interpolated — a session title is free text.

<!-- entry 113 -->
