# Every dollar figure now renders with two decimals

Every dollar figure now renders with exactly TWO decimals — the dashboard's `fmtCost`
(cards, ribbon, Repos/Sessions tables, History tooltips) and the statusline's cost segment.
Sub-$1 values previously showed three ("$0.042"), so a column mixed two- and three-decimal
figures and the statusline read to the tenth of a cent; a flat 2 keeps the column aligned.
Zero-decimal currencies (JPY etc.) are unchanged — they never carried fractional digits.

<!-- entry 207 -->
