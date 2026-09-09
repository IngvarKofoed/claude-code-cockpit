# WT tab path confirms selection only, not the raise

Correction to entry 124 and the architecture doc: the WT tab path confirms its tab SELECTION,
not that the window came forward — it still reports ok from `` alone. Only the `pid:`
raise is GetForegroundWindow-confirmed. The WT path is verified working in practice (its UIA
Select() brings WT along) so it is left as is, but must not be described as raise-confirmed.

<!-- entry 132 -->
