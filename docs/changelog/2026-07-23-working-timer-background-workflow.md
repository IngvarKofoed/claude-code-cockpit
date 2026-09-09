# Big timer keeps counting during background workflows

The big live-card timer now KEEPS COUNTING while a background workflow runs. Before, it showed "— / prompt"
once the launching turn's Stop cleared `currentPrompt`, even though the session's subagents were still
working. `aggregate` now stamps `session.engagedStartedAt` (start of the current continuous engaged period,
persisting across the Stop while subagents stay in flight, cleared when fully idle); the card ticks from it
(label "working") when there's no open prompt but a subagent is active. So an open turn still shows its
prompt timer, and a background workflow shows a continuous "working" timer instead of a frozen dash.

<!-- entry 20 -->
