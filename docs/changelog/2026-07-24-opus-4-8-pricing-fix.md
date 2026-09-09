# Fixed opus-4-8 default pricing, a 3x overestimate

Fixed the default pricing table: `claude-opus-4-8` was at the retired Opus 4.1/4.0 tier ($15/$75) — a 3x
cost overestimate on the most-used model — now Opus 4.5+ pricing ($5/$25). Added the other shipping models
(Fable 5, Opus 4.7/4.6/4.5, Sonnet 4.6/4.5) so they price out of the box instead of `—`. Sonnet 5 kept at
standard $3/$15 (its $2/$10 intro rate lapses 2026-08-31). Defaults only — a saved custom `rates` map still
overrides these, and there is no live pricing fetch, so a new/unlisted model shows unpriced until added.

<!-- entry 22 -->
