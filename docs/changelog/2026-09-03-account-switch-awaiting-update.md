# Usage bars show awaiting-update state after a switch

The stamp necessarily postdates the readings it judges (a switch is only observed while
handling a push), so the switch-revealing push is itself dropped — its reading may predate
the switch. The bars then show a dimmed "account switched — awaiting update" until the next
event bumps a session past `since`: seconds for a running session, one turn for an idle
fleet. Honest degradation, the same shape as `reset • awaiting update`.

<!-- entry 187 -->
