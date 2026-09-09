# Usage-bar subscription transitions and drops now logged

The usage-bar subscription path (`handleInternalUsage`) now logs to daemon.log (metadata only) (v0.33.0):
current-subscription TRANSITIONS and any DROPPED statusline push (pushing sub, 5h %, current sub, session).
Added so a recurrence of the idle-session hijack — an idle session on a secondary subscription winning
`currentSubscription`, freezing the usage bar at a stale value (observed once: 54% while every live
session's statusline showed 95%) — is diagnosable from the log alone, not by live `/api/state` inspection.
Near-zero volume: the transition fires only on a real change; the DROP line is silent unless a push is
actually discarded (deduped). Pure observability — no behavior change; the selection fix itself was deferred.

<!-- entry 86 -->
