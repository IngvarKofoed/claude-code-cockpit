# Dashboard static assets served with no-cache

Dashboard static assets (index.html / app.js / charts.js / styles.css) are now served with
`Cache-Control: no-cache` (v0.20.0). serveStatic previously sent NO cache directive, so browsers
heuristically cached styles.css / app.js across daemon upgrades — a UI edit could render with the new JS
but STALE CSS (e.g. a chart not filling its card) until a manual hard reload. no-cache makes an ordinary
reload always fetch fresh; the daemon is local and the assets are tiny, so freshness beats caching.

<!-- entry 59 -->
