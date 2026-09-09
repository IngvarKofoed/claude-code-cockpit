# Usage bars show absolute reset clock time

The Live usage bars now show the ABSOLUTE reset moment next to the countdown, not just "resets in …" (v0.15.0):
the 5h bar appends the local clock time ("resets in 4h 02m · 10:30"), the weekly bar appends weekday +
day + month + time ("resets in 5d 4h · Sun 12 Jul, 11:00") — the multi-day window needs the date to be
unambiguous. The 5h bar's bare time gains a weekday prefix ("· Thu 03:00") ONLY when the reset lands on
another local day than now — an evening-started rolling 5h window resets after midnight, so a plain
"03:00" would misread as earlier today. One shared `fmtResetLine` (countdown + `fmtResetAt`, keyed by a
`withDate` flag) builds the line for BOTH the render path and the per-second tick path, so they can't
drift; the absolute time is fixed while only the countdown advances. `.usage-bar__foot` gained
`flex-wrap` so the now-longer line wraps the pace-delta chip below it on a narrow bar instead of
overflowing; the chip uses `margin-left:auto` (not `justify-content:space-between`) so it stays
right-aligned whether it shares the line or wraps.

<!-- entry 51 -->
