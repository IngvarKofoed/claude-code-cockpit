# Live card timer freezes instead of counting while waiting

The Live card's big timer no longer counts up while `waiting`; it FREEZES (label "paused") at how long
the prompt ran before it blocked — anchored to a new STABLE `session.waitingSince` (aggregate sets it
once on entering waiting, clears it on leaving), so a benign mid-wait event that refreshes lastActivityAt
can't creep it. Ticks only while running/engaged; on approval "elapsed" resumes from true prompt
wall-clock (the Active stat, not this timer, is the wait-excluding metric). Cause: a permission
Notification sets `waiting` without clearing currentPrompt, so the prompt timer kept ticking on a blocked card.

<!-- entry 30 -->
