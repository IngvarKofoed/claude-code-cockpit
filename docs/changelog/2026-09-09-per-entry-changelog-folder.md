# Changelog is a per-entry folder, not a single numbered file

Every change now gets its own `docs/changelog/YYYY-MM-DD-<slug>.md`; `docs/CHANGELOG.md` is gone
from the working tree. Two parallel changes can no longer collide, because no two reach for the
same path — an invariant the numbering scheme could not hold without a global sequencer.
208 existing entries were backfilled into the folder, each keeping an `<!-- entry N -->` marker.

## Detail

- **The backfilled dates are synthetic.** Per-entry git archaeology is unreliable here — entries were
  added in bulk, edited later, and renumbered twice — so dates were spread evenly across the repo's
  life instead: 4 per day, walking back from 2026-09-08 to 2026-07-19 (first commit 2026-07-02).
  Order and rough vintage are right; the dates are not real. An entry citing a dated `docs/specs/…`
  path can therefore disagree with its own filename. Entries written from now on have real dates
  and no marker.
- **`entry N` citations resolve by grep, not by filename.** The old entries cite each other constantly
  ("reverses entry 25", "per entry 103"), and roughly forty such references exist. The `<!-- entry N -->`
  marker is the only thing keeping them resolvable: `grep -rl 'entry <N>' docs/changelog/`. Removing a
  marker silently breaks a citation with nothing to catch it.
- **Rejected: keeping the single file, with a curated digest for reach.** A digest is one file every
  change appends to and every compaction rewrites — reintroducing in miniature exactly the collision
  the folder removes, and the rewrite half is a real semantic conflict rather than a keep-both append.
  Reach is instead the full `ls` index plus a grep over the folder, both mandated in `CLAUDE.md`.
- **Deletion was gated on verification, run before `docs/CHANGELOG.md` was removed:** 208 entries parsed
  == 208 files written; 208 distinct markers covering 1..208 with none missing; and every body compared
  whitespace-normalized against its source chunk, all 208 equivalent. Bodies were copied mechanically,
  never retyped — only the leading number and the numbered-list hanging indent were stripped.
- **Nothing is lost.** `git show 6f45a42:docs/CHANGELOG.md` retrieves the original; no history was rewritten.
- Known limit: entry *titles* were generated for the backfill (the old entries had none), so a title is a
  summary written after the fact, not the author's words. The bodies are the author's; the titles are not.
