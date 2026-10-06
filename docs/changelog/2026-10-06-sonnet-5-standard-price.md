# Sonnet 5 priced at $2/$10, its permanent standard rate

Sonnet 5's default rate is now $2/$10 (cacheRead 0.2, cacheWrite 2.5 / 1h 4). Its launch "intro"
price became the standard one and the scheduled 2026-09-01 rise to $3/$15 was cancelled, so the
old default over-stated Sonnet 5 cost by 50%. The CONFIG_VERSION 4 migration corrects a persisted
rate still at the v3 default; a customized one is kept.

## Detail

- **Reverses entry 22** (`2026-07-24-opus-4-8-pricing-fix`) and `2026-08-22-pricing-table-expansion`,
  which deliberately kept Sonnet 5 at $3/$15 in anticipation of the rise. That anticipation was
  the whole reason; with the rise cancelled there is no case for the old figure.
- Matched by value like `PRE_V1_DEFAULT_RATES` (`2026-07-24-pricing-rate-migration`), with the same
  accepted trade-off: a user who deliberately typed $3/$15 is upgraded too — never a correct
  Sonnet 5 rate now. Unlike v1, the match also checks `cacheWrite1h` when present, so a rate edited
  only in its 1-hour class counts as customized and is left alone.
- A v2 config reaches the v4 step without `cacheWrite1h` on Sonnet 5: the v2→v3 fill compares
  against the *current* default, which this change moved. The v4 step therefore treats an absent
  1h class as matching the old default. Covered by a test.
- Known side effect of that same coupling, accepted: a v2 config whose Sonnet 5 was hand-set to
  $2/$10/0.2/2.5 now looks "unedited" to the v2→v3 step and gains `cacheWrite1h: 4` — the correct
  rate. The real fix (freezing each version's shipped defaults for its own step) wasn't worth it.
