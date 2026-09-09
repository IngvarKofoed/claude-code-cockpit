# Live view gains per-browser Status or Name sort

Live view gained a per-browser sort toggle (`Status | Name`) in its header. `Name` sorts cards purely
alphabetically by repo (then cwd, then sessionId) for STABLE positions that don't reorder on activity;
`Status` (default) keeps the server's waiting-first order. Client-only, remembered in `localStorage`
(`cockpit.liveSort`) — the daemon's `compareCards` is untouched. Waiting is not floated up in `Name` mode;
acceptable because the working set is small (grid never scrolls) and the ribbon's "Waiting" tile backstops.

<!-- entry 15 -->
