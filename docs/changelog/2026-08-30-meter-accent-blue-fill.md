# Dashboard meters fill accent blue instead of green

All three dashboard meters — the per-card context gauge and the ribbon's 5h and weekly usage
bars — fill ACCENT BLUE below 65% instead of the running-green. On a page of status rails and
badges a green bar read as "this session is working" at a glance; blue is the neutral "here is
a level" hue, leaving only the unchanged amber/red bands to carry urgency.
Changed in `usageColor`'s safe band, so the thresholds stay in one place (entry 143). The
statusline's own ramp is untouched — its hues are terminal colours, not these tokens.

<!-- entry 171 -->
