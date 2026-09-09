# Automatic retention pruning removed, cleanup now manual

Automatic retention pruning is gone: the `retentionDays` config field and the `pruneOld` timer are removed.
Chosen because the user wants the store cleaned only on demand, never behind their back. History now grows
unbounded until a manual cleanup. A persisted `retentionDays` goes inert (dropped as an unknown key by
`validateConfig`; no migration). Behavior flip worth noting: anyone who had set `retentionDays` to bound
disk now keeps everything until they clean up.

<!-- entry 27 -->
