# Live cards gain Agents and Tools stat columns

Live cards show two new per-session stat columns — Agents (`subagents.total`, per-type tooltip) and Tools
(`session.toolCount`) — and the wall-clock Age column was dropped, so the row is now
Chats·Tokens·[Cost]·Active·Agents·Tools. Note the display labels: the prompt-count column is labelled
"Chats" (field is still `promptCount`) and the subagent column "Agents" — a UI wording choice; the "Chats"
rename also applies to the Per-repo table's prompt column. Card width tuned to `.cards` minmax
min(420px,100%) so THREE cards fit across the 1400px content column, with a tight stat-grid gap + compact
mono values so the (now 6) columns fit. The old active-subagent chip was removed (column + tooltip
subsume it).

<!-- entry 16 -->
