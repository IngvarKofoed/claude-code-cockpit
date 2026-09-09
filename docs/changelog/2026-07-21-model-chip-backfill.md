# Model chip now reliably backfilled from transcript

The model chip is now reliable. `session.model` is backfilled from the transcript on each usage read,
picking the DOMINANT model by output tokens. Before, model came only from `SessionStart` — the sole hook
that carries it, and it may omit it — so resumed / post-snapshot-loss sessions showed no model. Dominant-
by-output (not the most-recent message) avoids mislabeling a session with a transient compaction/sub-model.

<!-- entry 12 -->
