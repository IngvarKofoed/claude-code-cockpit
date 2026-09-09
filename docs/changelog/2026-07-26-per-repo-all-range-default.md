# Per-repo view now defaults to the All range

Per-repo view now defaults to the All range (was Today), and its non-today ranges no longer show "—" for
Chats, Sessions, and Last active. The `/api/history` topRepos now carries `prompts`/`sessions`/`lastActive`
(previously dropped, so `loadRepos` hard-coded them null). Sessions are now derived for EVERY day the same
way — from the event log — by folding the session set into `addActiveFromEvents` (so past days match today,
and `rebuildTodayRollup`'s duplicate session loop is gone); `aggregateReposAcrossDates` unions distinct
session ids across days and takes the max lastActive. Consistent with the documented backfill limit: a
backfill-only day (tokens/cost, no events) still contributes 0 sessions / 0 chats / 0 active, so those
columns stay in step rather than diverging.
Two consequences of making All the default (found in review): `/api/history` topRepos is no longer
capped at 10 — the Per-repo table shows every repo in the range, and the History "Top repos" chart caps to
its top 10 client-side instead. And the table now live-refreshes on ALL ranges (was Today-only): SSE frames
trigger a throttled re-fetch (≤1/`REPO_REFRESH_MS`) for historical ranges so a default All view doesn't
freeze during active work.

<!-- entry 32 -->
