# Subscription tile shows today's account switch count

The Live ribbon's Subscription tile carries a muted `+ N` — today's switch count
("Corvus + 5"), from `/api/state`'s `accountSwitchesToday`. Rendered in the `—` branch too
(the count is true when the identity isn't), absent at zero, and colour-NEUTRAL because
despite the `+` it is a count, not a signed delta. The name ellipsizes, the count never
shrinks. Accepted seam: the label flips at the switch, the count ~500ms later.

<!-- entry 200 -->
