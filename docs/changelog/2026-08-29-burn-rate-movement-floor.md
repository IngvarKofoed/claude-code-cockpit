# Burn-rate readouts state a bound below two points of movement

`used_percentage` arrives as an INTEGER, so a delta carries ±1 point whatever the span.
Below 2 points of movement the readouts state their bound instead of a number that could be
off by half: `< 2%/6h` when there is history, `measuring…` when it doesn't reach back far
enough yet. Precision is worst near the cap, where 1 point is a large share of what's left —
which is why the projection keeps its "~" and longer spans are more trustworthy.

<!-- entry 165 -->
