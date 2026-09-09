# Trend arrow shows direction only, never magnitude

A DIRECTION, never a magnitude, and that is what makes it work on the weekly bar:
`used_percentage` is an INTEGER, so any delta carries ±1 point, and the SIGN survives that
where a precise ratio does not. Renders NOTHING — never text in the number's slot — with no
usable history, under 2 points of movement, inside a ±15% band, or at the cap. Within-band and
can't-measure look identical on purpose: both mean "don't act on this".

<!-- entry 174 -->
