# Context gauge degrades gracefully instead of lying

That gauge degrades rather than lying: no reading omits the row entirely (a session without the
statusline installed costs no card height, and never shows a misleading 0%), an unreadable one
never clears the last known value, and a reading older than 10 min dims — it is frozen, not
current. An unchanged reading is stored but does NOT broadcast; the statusline pushes on every
render and each broadcast rebuilds the whole card grid.

<!-- entry 119 -->
