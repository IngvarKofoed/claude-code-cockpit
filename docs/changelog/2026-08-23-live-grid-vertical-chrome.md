# Eighteen pixels reclaimed above the Live card grid

Reclaimed 18px above the Live card grid (measured 192→174px from the topbar border to the
first card) by trimming only VERTICAL chrome: `.main` top padding, `.tile` and `.usage-bar`
block padding, and the usage bar's head/foot margins. No font size, track, or horizontal
padding changed — tile width is already fully spent on the widest value (a 3-figure cost).
Deliberately NOT taken: the ribbon's tile grid wraps to a second 85px row below ~1315px
viewport width (8 tiles, `minmax(150px,1fr)` → 7 columns), which is by far the bigger win
there — but it needs the tile narrower than its widest value, so it was left alone.

<!-- entry 142 -->
