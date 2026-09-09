# Pricing work's v0.41.0 tag collided with Windows-focus release

Tagged the pricing work (entries 133–140) v0.41.0 locally, per entry 103's rule that only a
version change replaces a running daemon. That tag COLLIDED: the Windows-focus work
(entries 121–132) reached origin as v0.41.0 first, so the two never shared a release.
Pricing only ever reaches anyone as v0.42.0 (entry 145), which is the first version
carrying both. The `(v0.41.0)` tags on 133–140 record their commit, not what shipped.

<!-- entry 141 -->
