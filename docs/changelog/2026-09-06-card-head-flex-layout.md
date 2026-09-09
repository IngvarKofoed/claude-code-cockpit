# Card head qualifier absorbs squeeze, repo name never shrinks

In the card head the repo NAME never shrinks; the qualifier absorbs the whole squeeze and
ellipsizes. Measured: flex spreads a deficit in proportion to basis, so ANY shrink factor
on a short name ("flux") eats it to "fl…" once the qualifier is long, and a `min-width`
floor pads every short name and shoves the separator away from it. `min(8ch, max-content)`
is rejected by Chromium; `calc(100% - 8ch)` collapsed "flux · Spec" to 3px. Don't re-try.

<!-- entry 197 -->
