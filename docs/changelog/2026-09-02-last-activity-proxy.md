# lastActivityAt treated as a proxy for reading freshness

`lastActivityAt` is a PROXY, not a receipt: a prompt, a resume, or an `idle_prompt` bumps it
with no API response behind it. Accepted both ways — that bump is what rescues a running
session seconds after a switch, at the cost of a one-push mislabeling window for a session
prompted right after one. Do not re-fix with API-only event filtering.

<!-- entry 184 -->
