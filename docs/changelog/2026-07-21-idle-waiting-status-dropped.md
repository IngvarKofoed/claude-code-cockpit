# Idle-waiting status dropped, restoring four-status model

Dropped the `idle-waiting` status ("Idle — awaiting input"); a finished turn now stays plain `idle`,
restoring CONCEPT's four-status model. It flagged Claude Code's `idle_prompt` ("done, awaiting next
prompt"), which read as needs-attention on a done turn — and also fires mid-turn while a subagent works,
so it's no reliable "awaiting you" signal. Now only a permission `Notification` → `waiting`; `idle_prompt`
settles a running session to idle only when nothing's in flight (guards a lost Stop), never as "waiting".

<!-- entry 10 -->
