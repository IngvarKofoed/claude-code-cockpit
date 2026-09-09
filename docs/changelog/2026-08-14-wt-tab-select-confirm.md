# Windows Terminal tab selection confirmed before returning

The tab Select is CONFIRMED before the script returns (poll IsSelected, one re-issue). WT applies
the UIA request on its own UI thread, so firing Select() and exiting can lose it — observed once as
the window coming forward still showing the previous tab. A raise whose selection never lands
reports `tab-not-selected`, kept distinct from `no-window` so the toast can say what happened.
`ambiguous-tab` and `tab-not-selected` are definitive: neither falls through to the window target.

<!-- entry 106 -->
