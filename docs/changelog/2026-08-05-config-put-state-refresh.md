# Config updates now also push a fresh state frame

`PUT /api/config` now also pushes a fresh STATE frame (`markDirty`), not just the config frame.
Several state fields are server-computed from config — subscription labels (via
`subscriptionLabelPattern`) and every cost figure — so without it an already-open dashboard kept
showing stale labels/costs until the next event or a reload. Found in browser verification:
editing the label pattern didn't relabel the Live chip live; now it does.

<!-- entry 69 -->
