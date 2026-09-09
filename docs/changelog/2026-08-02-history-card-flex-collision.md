# History card class collision fixed, charts render full width

Fixed History charts rendering shrunken and not filling their card (v0.20.0). `#histBody .card` reused
the global `.card` name (the Live-session card, which is display:flex), so History cards became flex
ROWS — title in a left column, chart at only its intrinsic width, the card half-empty. Root cause: a
class-name collision the `#histBody` scoping didn't neutralize because it never overrode `display`; now
`#histBody .card` sets `display: block`.
`lineChart` now also renders at its container's REAL pixel width (`vw(host)`) instead of a fixed 640
viewBox CSS-scaled to fit — so the full-width "Tokens & cost per day" hero fills the width crisply at its
360px height rather than aspect-scaling into a ~750px-tall giant. The fixed-geometry charts (bars/
stacked/donut/punch/calendar) keep the 640 grid + CSS scaling.

<!-- entry 60 -->
