# Usage bars now gated by a reading-freshness guard

Replaced by a freshness guard: a push updates the bars iff its reading (a) postdates the
last observed account switch and (b) is at least as fresh as the accepted snapshot's.
Freshness is the pushing session's `lastActivityAt`, so a running session always beats an
idle one re-pushing its frozen payload. Pure + unit-tested as `usage.acceptUsagePush`;
both checks fail open on an unknown side, and a fail-open accept stores a null baseline —
the guard ratchets OPEN, never shut.

<!-- entry 183 -->
