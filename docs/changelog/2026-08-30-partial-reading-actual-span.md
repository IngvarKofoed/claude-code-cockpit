# Partial burn-rate readings divide by the span actually covered

A partial reading divides by the span it ACTUALLY covers, never the nominal one — otherwise
3 points burned in 1.2h, spread across a 3h setting, would understate the rate by more than
half. It wears that span inline while the window fills ("3.9× · 1.2h", muted suffix) and
drops it once full, so a bare multiplier always means the whole configured window and a thin
30-minute reading under a 24h span is visible rather than hidden behind its label.
Every no-rate message now names the observed span too ("< 2%/1.2h", "fallen over the last 1.5h").

<!-- entry 170 -->
