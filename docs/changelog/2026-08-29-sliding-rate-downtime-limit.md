# Sliding rate overstates burn after daemon downtime

Known limit of the sliding rate, documented not fixed: it divides by the NOMINAL lookback,
exact only while the sample buffer is gap-free — which it is by construction while the
daemon runs (change-only sampling means "no sample since the anchor" really means flat).
A daemon DOWN while the percentage rose attributes the whole gap-sized delta to the
lookback, overstating until a post-restart sample crosses the cutoff (≤ one lookback).

<!-- entry 166 -->
