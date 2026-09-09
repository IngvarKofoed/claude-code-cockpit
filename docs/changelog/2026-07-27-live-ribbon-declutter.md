# Live view decluttered with two new ribbon tiles

Live view decluttered + two new ribbon tiles. Removed the topbar brand (icon + "Cockpit / mission
control") and the Live header (title + "N active" note) — pure chrome; nav tabs + connection dot remain.
The Live ribbon gains "Active agents" (Σ session.bgTasks — background tasks/workflow agents in flight now,
from the authoritative count, NOT drift-prone subagents.active) and "Active time" (Σ session.activeMs of
the live sessions — rolls up each card's Active stat).
The Status/Name sort moved from the Live header to Settings > Dashboard ("Live view sort") — still a
per-browser localStorage pref (not daemon config), intercepted before the config-save handler so it
never PUTs or pops a "Settings saved" toast.

<!-- entry 34 -->
