# Live ribbon tiles become pure today's-totals summary

The Live ribbon tiles are now a pure today's-totals summary: `Tokens | Cost | Sessions | Chats | Tools |
Agents | Active time`. Added Chats (Σ today's `prompts`) and Tools (Σ today's `byTool`), both summed from
the today per-repo rollup like the existing tiles. The momentary Running / Waiting status tiles were
DROPPED per user request (reverses entry 38's keep — status is still on each card's badge), so the ribbon
no longer reads the live-session list at all; `renderLiveRibbon` dropped its `sessions` param.
Consequence (accepted): this removes the ribbon's `tile--alert` Waiting signal that entry 15 named as the
backstop for "Name" sort mode (where waiting cards aren't floated up) — in that non-default mode a blocked
session below the fold now has no global surfacing cue but its own amber card. Don't re-add the tile to "fix"
this without asking; the drop was the explicit request.

<!-- entry 48 -->
