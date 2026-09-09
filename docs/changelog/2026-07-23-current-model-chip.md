# Model chip now shows session's current model

The Live card's model chip now shows the session's CURRENT model, reversing entry 12's dominant-by-output.
`updateSessionTokens` sets `session.model` from the most-recent transcript message with `output>0`,
EXCLUDING sidechain (subagent) turns and `<synthetic>`/`unknown` pseudo-models (`isDisplayModel` +
the new `transcript.js` `sidechain` flag) — so a mid-session `/model` switch shows on the next real turn
without a subagent's cheaper model or a usage-only record mislabeling it. `session.modelsUsed` (real models,
first-seen) drives a "models this session (current)" tooltip. Display only — per-message token/cost
attribution is unchanged (only a truly model-less message's fallback bucket tracks the displayed model).

<!-- entry 18 -->
