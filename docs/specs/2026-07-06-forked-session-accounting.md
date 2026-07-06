# Forked-session accounting: global token dedup + fork badge

A `--fork-session --resume <parent>.jsonl` fork (Claude Code backgrounding a
session, or a fork subagent) copies the parent's transcript history into its own
transcript **keeping the same message-uuids**, then runs as a fully independent
session with its own `session_id`. This breaks two assumptions in the cockpit:

1. Token dedup is keyed per `session_id`, so the fork re-counts every message the
   parent already billed — inflating the shared repo's tokens and estimated cost.
   (Verified live: parent `af1da441` and fork `df7d7a35` share 41 message-uuids in
   the usage logs, same `repo_root`.)
2. The fork gets its own Live card with the **same repo name and `ai-title`** as the
   parent (inherited `cwd` + copied transcript), so two identical-looking cards
   appear for "one console" — reading as a phantom/bug.

This spec fixes the double-count by **deduping token attribution on the globally
unique message-uuid instead of per session**, and disambiguates the cards by
**inferring fork-ness from the shared uuids** the dedup pass already sees, badging
the fork on the Live card. Active time is deliberately untouched — two concurrent
sessions on one repo (forked *or* manually started) correctly sum active time.

## Key decisions

- **Dedup on message-uuid globally, not per session** (breaking). Replace the
  per-session `seenIds` map (`daemon.js:66`) with a single global
  `countedIds: Set<key>`. A real API message id (`uuid`/`msg.id`/`requestId`, per
  `transcript.js:39`) is assigned once and globally unique, so a global set only ever
  collapses a fork's *literal copies* of another session's messages — never two
  genuinely distinct messages. This is the minimal change that makes attribution
  idempotent across sessions, restoring the invariant `ARCHITECTURE.md` already claims
  ("keyed by message id … re-reads can't double-count") which today holds only
  *within* a session.
- **Positional fallback ids stay per-session-scoped** (extends). When a transcript
  line carries no real id, `transcript.js:115` synthesizes a *positional* id
  `__idx_${i}` — which is NOT globally unique (session A's `__idx_5` ≠ session B's).
  Putting those in the global set would silently drop a distinct message's tokens
  (under-count) and false-collide fork detection. So the daemon **namespaces any
  `__idx_*` key by session_id** (e.g. `sid\0__idx_5`) before inserting/checking it in
  `countedIds`, and excludes namespaced keys from fork detection. On re-seed each
  usage record carries its `session_id`, so the same namespacing reconstructs
  identically. Net: real ids dedup globally (fixes forks); id-less fallback ids keep
  today's per-session behavior (no regression on the version-drift path the synthetic
  id exists to tolerate).
- **Race-freedom rests on synchronous check-and-mark** (reuses). The fix is correct
  under the existing async flush-retry loop (`setTimeout(attempt, …)`) because each
  `attempt`'s read → `fresh` filter → `recordTurn` mark runs synchronously with no
  `await` between the `countedIds.has` check and the `countedIds.add`. Whichever
  session ingests a shared uuid first wins; the other re-checks the current set and
  skips. Preserve this: never introduce an `await` between the fresh-filter and the
  mark.
- **Drop the `allBackfill` seen-exclusion** (diverges). `recordTurn` currently skips
  marking backfilled ids to avoid bloating the per-session map (`daemon.js:994`).
  With one global set that reasoning is void — always mark counted, so a second
  backfill run in the same daemon lifetime can't re-count.
- **Fork detection from shared real-uuids in the usage log** (new). A session
  shares history with another iff ≥1 of its *real* message-uuids also appears under a
  different `session_id` in the usage logs (positional `__idx_*` keys are excluded —
  they'd false-match). Computed in the *same* single pass over the usage logs that
  seeds `countedIds` — no OS process inspection, no new hook field, no dependency on
  Claude-Code-internal transcript markers. This is chosen over the simpler
  `SessionStart.source` because the fork emits **no `SessionStart` under its own id**:
  observed in the live event log, the fork's process fired a `SessionStart` carrying
  the *parent's* `session_id` (`source: "resume"`), then diverged to its own id via
  later events — so `source` never arrives for the fork's session. This is
  Claude-Code-internal behavior that can shift between versions; **confirm with the
  `claude-code-guide` agent at build time** (per `scripts/CLAUDE.md`) before relying
  on it.
- **A symmetric `sharesHistory` flag, not a directional parent link** (extends).
  Session state gains a boolean `sharesHistory`; both twins that share real uuids get
  it, and both get the badge. We deliberately do NOT model "which is the parent":
  ordering in the logs is nondeterministic, and a background fork can write its `Stop`
  before the still-running parent ingests, so a directional `forkedFrom` would flip
  and badge the real console as the child. A symmetric flag is deterministic and never
  wrong; it fully solves the "why two identical cards" confusion without a claim we
  can't back. (Naming *which* twin is the headless one would need the rejected OS
  cmdline read.)
- **Tolerant snapshot load** (extends). `snapshot.json` stored `seenIds` as
  `{sid: [ids]}`; it becomes `countedIds: [ids]`. `loadSnapshot` flattens an old
  per-session map into the global set when it sees the old shape, so an in-place
  upgrade neither crashes nor re-counts. Durable usage logs remain the source of
  truth regardless.

## Goals

- A repo's token and cost totals count each message exactly once, even when a fork
  (or resume, or re-read) replays another session's message-uuids.
- Idempotent and crash-safe: a restart, a resume, or a re-run of backfill re-derives
  identical totals from the durable usage logs.
- A forked/background session is visibly distinguishable from the foreground session
  it shares a name with, so two cards for "one console" no longer read as a bug.

## Non-goals

- **Active-time changes.** Concurrent engaged sessions on one repo summing to more
  than wall-clock is correct (two real workers), and happens with manually-started
  sessions too — out of scope by explicit agreement.
- **De-duping per-session *displayed* tokens.** `session.tokens` on a card is the
  full-transcript sum from `transcript.readUsage().totals`, not the rollup, so a
  fork's card will still show tokens including its inherited history. That reflects
  the context the fork actually holds; only the **repo accounting** (rollups,
  `repoTotals`, the Repos table) is deduped.
- **Detecting *headless-ness* precisely.** Inference identifies fork-ness (the cause
  of the name collision), not whether a fork has a terminal. Reading
  `--bg-pty-host` from the OS process was considered and rejected (below).
- **Killing/managing forks.** Read-only observability stands (CONCEPT non-goal).

## Design

### Part 1 — global token dedup

Rename and re-scope the dedup state in `daemon.js`:

- `seenIds: Map<sid, Set<id>>` → `countedIds: Set<id>` (one global set).
- `primedSeen: Set<sid>` → `countedSeeded: boolean` (seeded once per lifetime).
- `ensureSeenSeeded(sid)` → `ensureCountedSeeded()`: one O(all-logs) pass that adds
  every usage record's `ids` to `countedIds` regardless of `session_id`, guarded by
  `countedSeeded`. (Strictly cheaper than today's O(sessions × all-logs) per-session
  seeding.)

Every read of `seenIds.get(sid)` becomes a read of the one `countedIds`:
`catchUpIngest` (`:389`), `recordTurn`'s fresh-filter + mark (`:990–997`), and
`ingestTurn`'s `attempt()` retry (`:969`). `dropSession` (`:922`) no longer deletes a
per-session set — counted ids persist for the daemon's life (that is the point).

The membership check and mark both go through one helper — `key(sid, id)` returns
`id` for a real id and `` `${sid}\0${id}` `` for a positional `__idx_*` id — so the
per-session scoping of fallback ids is applied uniformly at every call site (seed,
filter, mark) and can't drift between them.

Backfill (`countedIdsBySession`, `:442`) collapses into the same global set:
`backfillTranscripts` dedups against `countedIds` (seeding it first). The separate
per-session map existed only to avoid bloating the live maps; unnecessary now.

**Attribution is unchanged.** Rollups still sum each usage record's tokens by
`repo_root`/`byModel` (`applyUsageRecord`, `accumulateTurnByModel`). Because the
global dedup guarantees each uuid lands in exactly one usage record across *all*
sessions, the repo rollup counts it once.

**Snapshot:** `buildSnapshot` (`:1984`) writes `countedIds: [...]`. `loadSnapshot`
(`:275`) accepts either shape: an array → load directly; the legacy
`{sid: [ids]}` object → flatten all arrays into the set. The format change is not a
one-way door: an *old* daemon reading a new snapshot finds no `seenIds` and simply
re-seeds per-session from the usage logs (the source of truth) — safe, no
double-count on downgrade.

**Memory:** one flat set of all counted uuids (~36-char strings), roughly equal to
today's summed per-session map; unbounded within a lifetime but reset every restart
and trivially small (100k messages ≈ a few MB). Noted as a known limit.

### Part 2 — fork inference + badge

During `ensureCountedSeeded`'s single pass (iterating day files in **sorted** order
for determinism), additionally track a transient `firstSidOf: Map<realId, sid>` —
real ids only; namespaced `__idx_*` keys are skipped. On a collision (a real id
already recorded under a *different* sid), record the pair. Discard `firstSidOf`
after the pass, keeping only a compact map of sessions that share history. This is
restart-safe: a pure function of the durable usage logs.

- **Refresh:** recompute the shares-history set on the same triggers that clear the
  token caches (ingest, rollover, cleanup, repo-delete), and cache it like
  `repoTotals` so it never runs on the SSE broadcast path. A fork that first appears
  mid-lifetime is badged on the next ingest cycle (a small, acceptable latency).
- **Exposure:** each session in `/api/state` gains a boolean `sharesHistory`. No new
  endpoint.
- **UI (`web/app.js`, `web/styles.css`):** when `sharesHistory` is set, the Live card
  shows a muted "forked" chip beside the model/effort chips. Tooltip: "Shares
  transcript history with another session — a fork/background split; the two may show
  the same name, and one may have no terminal of its own." Says "another session"
  rather than naming or directing at a specific twin (see the symmetric-flag decision
  above).

### Docs to reconcile

- `ARCHITECTURE.md` — *Token usage ingestion*: state that dedup is keyed on the
  globally-unique message-uuid across all sessions (not per session), specifically so
  a `--fork-session` fork that inherits a parent's uuids can't double-count.
  *Active-time accounting* / background work: note that a `--fork-session` fork is
  booked as an **independent session** (own id, own active clock), distinct from the
  `workflow-subagent`-hooks-on-the-parent model currently described.
- `CONCEPT.md` — one line in the Live-view/session model: forked/background sessions
  appear as their own card, badged, and may share a name with the session they forked
  from.
- `docs/CHANGELOG.md` — a numbered entry at build time (per changelog discipline).

## Alternatives considered

- **Repo-scoped counted sets** (`Map<repo_root, Set<id>>`). Handles the fork case
  (same repo) but adds keying complexity for no gain — uuids are globally unique, so
  global dedup is already safe and simpler.
- **Keep per-session `seenIds`, add a parallel global set.** Smaller blast radius on
  the snapshot/resume/finalize code, but two overlapping structures tracking the same
  ids — more state to keep in sync for no correctness benefit.
- **Detect forks by reading the owner PID's OS command line** (`--fork-session` /
  `--bg-pty-host`). Precise, and the only way to know true headless-ness, but
  platform-specific (no `/proc` on macOS → spawn `ps`), fragile across Claude Code
  versions, and a subprocess the daemon otherwise avoids. Inference from shared uuids
  covers the case that actually causes confusion with none of that cost.
