# Background shell no longer holds its session engaged

A background SHELL (`run_in_background` Bash) no longer holds its session engaged.
`emit.js` records `bg_agents` — the registry minus `type: 'shell'` — and `backgroundWork()`
reads it wherever engagement is decided: engaged clock, `atRest`, card sort, the
`idle_prompt` lost-Stop rescue, `effectiveStatus`. Measured: a dev server billed 7.01h
active against 1.19h of real work, in one unbroken 5.73h span holding zero events.

<!-- entry 204 -->
