# Sliding rate returns a signed value instead of text states

`slidingRate` now returns a SIGNED rate plus the raw `points` delta, dropping the
`why: 'declining'|'coarse'` null-states that existed only to render text. A falling weekly
percentage is a real ▼ ("old usage ageing out faster than you spend"), not an absence of data.
`rate` is still null for the two genuine no-data cases (no base sample, span under 30 min), so
callers keep a null check.

<!-- entry 178 -->
