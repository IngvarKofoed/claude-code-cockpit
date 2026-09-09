# Usage samples are filtered by subscription, not cleared

Samples are subscription-FILTERED, not cleared on a switch. `currentSubscription` flips
several times a day in this store, and a delta spanning a flip reads tens of points
negative; filtering keeps each subscription's rate alive across a flip back. A drop of ≥10
points discards that subscription's history (a window reset, not a rolling window's decline).

<!-- entry 163 -->
