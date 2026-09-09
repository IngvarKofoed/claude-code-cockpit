# Auto-pause no longer starves on discarded usage pushes

The starvation was not cosmetic: `evalAutoPause` sat after the drop's `return`, so a 95%
reading arrived and the gate never armed. It now runs on every push that passes the new
guard — the only discarded readings are provably staler than one already evaluated.

<!-- entry 182 -->
