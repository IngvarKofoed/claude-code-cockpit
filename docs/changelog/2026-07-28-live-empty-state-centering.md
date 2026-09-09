# Live empty state spans and centers in the full column

The Live "No active sessions" empty state now spans the full content column (centered) and sits lower,
below the ribbon. Scoped as `#cards .empty { grid-column: 1 / -1 }` because `.cards` is a grid — without it
the box landed in the first ~420px cell (top-left), so its `text-align: center` only centered text inside a
left-anchored box. Scoped to `#cards` so the Repos/Sessions/loading empty states are untouched.

<!-- entry 40 -->
