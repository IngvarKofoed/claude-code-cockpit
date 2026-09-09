# Daemon keeps separate 5h and weekly usage sample buffers

The daemon now keeps ONE sample buffer PER WINDOW — `usageSamples` (weekly) plus a new
`usageSamples5h`, both snapshot-persisted — because the 5h percentage was never recorded at
all. Separate buffers, not one keyed map: retention differs (6h vs 1h, since the 5h series
resets every five hours and ticks far more often), and the split keeps the snapshot additive.
The steep-drop rule already handles the 5h reset, costing no arrow for its first 30 min.

<!-- entry 177 -->
