# Live card title modes

The Live card's head shows the repository name and nothing else (`web/app.js:659`), so two
sessions in the same repo — two worktrees, or two chats on `main` — produce two cards with an
identical heading. Add a per-browser **Card title** setting in `Settings ▸ Dashboard` that
picks what the head shows: repository name (today), repository + branch, repository + session
name, or repository + branch with the session name substituted on a long-lived branch
(`main`, `master`, `trunk`, `develop`) where the branch says nothing. Purely a rendering choice — `repoName`, `branch` and `title` all already
ride to the browser on `toCard` (`scripts/aggregate.js:485`), so the daemon is untouched.

## Key decisions

- **A per-browser localStorage pref, not daemon config** (reuses). `cockpit.liveTitle`,
  read in `init()` and written by a `setLiveTitle()` that mirrors `setLiveSort`
  (`web/app.js:1532`) — validate, persist, then `renderLive()` so the change lands at once,
  and never a `PUT /api/config`, so it can't pop a spurious "Settings saved" toast. Every neighbouring Live-card control (theme, live sort, the five `liveShow`
  switches) is already localStorage, and `ARCHITECTURE.md` states that rule outright.
- **One `cardQualifier(s)` function, two consumers** (extends). It returns the *second*
  segment for the current mode (a branch, a session name, or `null`) and is called by both
  the head renderer and the `liveSort: "name"` comparator, so the grid can never order cards
  by something other than what they display — the principle changelog 194 set one commit ago
  ("the name is what the card actually shows, so the grid reads in the order you see it").
- **Missing segments degrade to the repo name alone** (reuses). A non-git session and a
  detached HEAD both carry `branch: null` (`scripts/repo.js:21`), and `title` arrives
  asynchronously from the transcript, so every mode must render with either absent. It falls
  back to the plain repository name — never a dangling separator, never a `—` placeholder.
  This is the same no-wrong-zero rule the accounting surfaces follow.
- **Long-lived branch names are the uninformative ones** (new). A `DEFAULT_BRANCHES`
  constant — `main`, `master`, `trunk`, `develop` — compared case-insensitively, drives the
  fourth mode. Hardcoded rather than configurable: it is a four-element list, and a text
  field asking users to name their default branch is more setting than the feature is worth.
- **The qualifier yields all the space; the repo name never shrinks** (extends).
  `.card__repo` (`web/styles.css:614`) becomes a flex row of two spans, the name at
  `flex-shrink: 0` and the qualifier ellipsizing. This REVERSES the draft's "the name yields
  first" — measured in the browser, no shrink ratio survives: flex spreads a deficit in
  proportion to basis, so any factor on a short name (`flux`) eats it to `fl…` once the
  qualifier is long, and the guard against that (a `min-width` floor) pads every short name
  and shoves the separator away from it. It is also the better read — a repo name is short
  and is the card's identity, while a session name still distinguishes at its head. The
  head's `title=` tooltip carries the composed string either way.
- **The qualifier is styled as secondary** (new). Muted (`--ink-2`), normal weight, after a
  muted `·` — the repository name stays the bold anchor it is today, and the card head keeps
  one visual centre of gravity.
- **The `liveShow` line toggles are untouched** (diverges from the obvious tidy-up). Showing
  the branch in the head does *not* auto-hide the branch line below it. One control, one
  effect: a switch labelled "Show branch" that silently stops working because of a dropdown
  elsewhere is worse than a redundant line the user can turn off themselves. Independent in
  both directions — the head renders its qualifier from the mode alone, so "Repository ·
  session name" with the session-name line switched off is a supported combination (and the
  cheapest way to keep the name while reclaiming the line's height), not a state to guard against.

## Goals

- Tell two cards of the same repository apart at a glance, without opening either terminal.
- Cover the worktree case (same repo, different branch) and the several-chats-in-one-repo
  case (same repo, same branch) with one setting.
- Change nothing for a user who leaves the setting alone.

## Non-goals

- Any change to the Sessions table's Name column, the Repos table, or the statusline.
- Automatic disambiguation (show a branch only when a *different* live card collides). It
  needs no configuration and always shows the minimum, but a card's heading would then mutate
  when an unrelated session starts — the instability `liveSort: "name"` exists to prevent.
  Re-addable later as a fifth mode without disturbing anything here.
- A free-text title template (`{repo} · {branch}`). Four named modes cover the cases; a
  template buys a validation surface and an explainer for flexibility nobody asked for.

## Design

### The modes

`LIVE_TITLES = ["repo", "repo-branch", "repo-session", "repo-smart"]`, defaulting to `repo`,
validated on read exactly like `LIVE_SORTS` (`web/app.js:1530`) so an unknown stored value
falls back rather than rendering blank.

| Mode | Dropdown label | Qualifier |
| --- | --- | --- |
| `repo` | Repository name | none — today's head, unchanged |
| `repo-branch` | Repository · branch | `s.branch` |
| `repo-session` | Repository · session name | `s.title` |
| `repo-smart` | Repository · branch (session name on default branches) | `s.branch`, unless it is a long-lived branch or absent — then `s.title` |

```js
const DEFAULT_BRANCHES = ["main", "master", "trunk", "develop"];

function cardQualifier(s) {
  const branch = s.branch || null;
  const title = s.title || null;
  switch (App.liveTitle) {
    case "repo-branch":  return branch;
    case "repo-session": return title;
    case "repo-smart":
      // A default branch names nothing this card doesn't already say, and neither does
      // an absent one (non-git session, detached HEAD) — fall through to the name.
      return branch && !DEFAULT_BRANCHES.includes(branch.toLowerCase()) ? branch : title;
    default: return null;
  }
}
```

`cardHTML` (`web/app.js:525`) renders the head as the repo-name span plus, when
`cardQualifier(s)` is non-null, a `·` and the qualifier span; the `title=` attribute carries
the joined string. With no qualifier the markup is what ships today.

### Sorting

The `liveSort: "name"` comparator (`web/app.js:1441`) keeps its `repoName → repoRoot → …`
grouping and swaps its final `title` tie-break for `cardQualifier(s) ?? s.title`. Under the
default mode the qualifier is null for every card, so the comparator is byte-for-byte today's
behaviour; under `repo-session` the qualifier *is* the title, likewise. Only `repo-branch` and
`repo-smart` change the within-repo order — to the order those cards now read in. The existing
"unnamed sinks below every named one in its repo" rule carries over unchanged, now keyed on the
qualifier.

### Settings

One `fieldRow` in the Dashboard section (`web/app.js:2527`), directly above **Live view sort**
since the two both shape how the grid reads, using the same `<select class="select">` markup.
Its `change` handler is one more early-return branch beside `set-liveSort` in the delegated
`#settings` listener (`web/app.js:2985`), so it never falls through to `scheduleSave()`.
Description text: *"What each live card's heading shows (this browser only)"*.

### Layout

`.card__head` is a flex row (`web/styles.css:609`) whose focus button and status badge never
shrink, so every bit of overflow pressure lands on the title. `.card__repo` becomes a flex
container (`min-width: 0`, baseline-aligned) holding `.card__repo-name` and
`.card__repo-qual`; `overflow: hidden` on it is load-bearing, not cosmetic — it zeroes a flex
item's automatic minimum size, which is what keeps a long title from pushing the focus button
and status badge off the card (the mechanism today's single span already relies on).

The name is `flex: 0 0 auto` and the qualifier `flex: 0 1 auto` with the ellipsis, so at the
grid's real card width (~444px on a 1440px viewport, ~428px at the 420px minimum track) the
repository name always renders whole and the qualifier truncates from the right, keeping its
distinguishing head (`Candidate sink test im…`). Verified across both widths: no head
overflow, the badge never clipped, and no gap between a short name and its separator.

Only a repo name wider than the whole head — ~40 characters — leaves no qualifier at all and
is then clipped by `.card__repo`'s `overflow: hidden` without an ellipsis. Confirmed in the
browser that the badge and focus button still survive that case, which is the part that
matters; a name that long has no good rendering.

Deliberately not done: ellipsizing a branch from the *left* (`…/retry-budget`), where the tail
is the informative half. It needs a `direction: rtl` hack that mangles punctuation, and it
would truncate inconsistently beside a session name in the same slot.

## Alternatives considered

- **Daemon config (`liveCardTitle` in `config.json`).** Would follow the user to another
  browser or machine, but adds a schema key, a validation branch and an SSE config broadcast
  for a purely visual preference — and diverges from the settled rule that Live-card display
  prefs are per-browser.
- **Automatic disambiguation.** See Non-goals: no setting at all, at the cost of a heading
  that changes when an unrelated session appears.

## Implementation strategy

*Not part of the design — a starting point for whoever builds this.*

- **Single agent, Sonnet 5.** Two files (`web/app.js`, `web/styles.css`) on one render path,
  and every touch point — pref, helper, head, comparator, Settings row — depends on the same
  `cardQualifier`; splitting it would only produce conflicts.
- The one judgment call is the head's flex-shrink balance, which is settled by looking at a
  narrow card in the browser (`web/CLAUDE.md`'s Playwright verification step), not by
  reasoning — so budget a real browser pass rather than a stronger model.
