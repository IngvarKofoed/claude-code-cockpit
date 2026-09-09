# Live cards show the session's AI-generated title

Live cards now show the session's AI-generated name above the branch line (v0.30.0), same 12px/muted
styling as the branch. Daemon backfills `session.title` from the transcript `ai-title` on each token
read (same source as the Sessions view), only overwriting when present so a pre-flush read can't clear
it; flows to the card via the existing `toCard` spread and the snapshot, so it survives a restart.
Omitted when no title yet (or transcript unreadable) — no empty line. Still the DERIVED title only,
never the verbatim last prompt (the privacy boundary).
`pollTokens` also backfills a LATE-arriving title on an idle-but-live session (Claude Code writes the
ai-title async, often after the turn's Stop) — otherwise the card stayed nameless until the next prompt.
Gated on the transcript mtime changing + `title==null`, so an idle transcript that never gains a title
isn't re-parsed every poll. The `.card__title` CSS is scoped to `#cards` — the History chart cards reuse
the same class, so an unscoped rule leaked the muted colour + ellipsis onto their titles.

<!-- entry 80 -->
