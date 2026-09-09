# Usage-bar clauses divided by a pipe, not a dot

The two clauses are divided by "|", not the "·" the reset clause uses between its own countdown
and absolute time — reusing "·" made the whole line read as one undifferentiated four-part run.
Its spacing is a MARGIN, not a trailing space in `content`: the pipe inherits the foot's 8px
flex column-gap on its left, so a ~3px text space on the right sat it visibly off-centre.
The delimiter belongs to the clause element, so `:empty` drops it and it can never dangle.

<!-- entry 155 -->
