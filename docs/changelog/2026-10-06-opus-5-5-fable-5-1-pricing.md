# Opus 5.5, Fable 5.1, Mythos 5.1 and Sonnet 5.5 price out of the box

The 5.1 / 5.5 point releases now have default rates, and CONFIG_VERSION 4 adds them to a
persisted `rates` map. They were unpriced, so every turn rendered "—" and was dropped from
totals — $2,319 of real spend in this store since 2026-10-01 (Opus 5.5 $1,743, Fable 5.1 $576).
History re-prices on its own: cost is computed at read time from stored token counts.

## Detail

- **Rejected: a version-stripping fallback** (`claude-opus-5-5` → `claude-opus-5`) so future point
  releases price automatically. It prices them *wrong* rather than visibly unpriced: Opus 5.5 is
  $4/$20 against Opus 5's $5/$25, and cache reads — most of Claude Code's spend — are 0.05× input
  on Opus 5.5 and 0.025× on Fable/Mythos 5.1, not 0.1×. A silent wrong number breaks the
  "unknown model renders —, never a guess" rule. `2026-08-21-base-model-rate-fallback` strips only
  a `[1m]` variant (and, later, a dated snapshot) because those provably bill at the base rate; a
  point release has no such guarantee. Each release needs its own key.
- **Cache-read multipliers are no longer uniform**, so never derive a new model's rate from its
  input price — copy the whole row from the pricing page. Rates here were taken from
  platform.claude.com/docs/en/about-claude/pricing on 2026-10-06.
- The v4 key re-add follows `2026-08-21-config-version-2-rate-migration`: absent keys only, since
  their absence can't be a deliberate Settings removal; an existing entry is never touched.
- Known limit, unchanged: Opus 5.5 fast mode ($8/$40) shares the model id, so it under-estimates,
  as `2026-08-21-opus-5-default-pricing` accepted for Opus 5.
- Pre-existing, not addressed: Claude Code's `<synthetic>` model id (zero-token placeholder
  records) still lands in `estimateCost().unpriced`.
- Config is loaded at daemon boot, so this reaches a running daemon only once a version bump lets
  `ensure.js` replace it (entry 103).
