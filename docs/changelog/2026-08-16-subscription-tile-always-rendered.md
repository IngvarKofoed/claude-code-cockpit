# Live ribbon Subscription tile is always rendered

The Live ribbon's Subscription tile is now ALWAYS rendered (v0.39.0), reading "—" with the
reason in its tooltip when no live session reports one (API-key / pre-feature session, or no
live session at all). Reverses entry 73's omit-when-unknown: the tile vanishing shifted the
ribbon's whole leading column, and "—" is how every other unavailable value already reads.

<!-- entry 115 -->
