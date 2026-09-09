# One cardQualifier function drives card head and sort

One `cardQualifier()` produces that second segment, shared by the card head AND the
"Repository name" sort, so the grid can never order cards by something other than what
they display (entry 194). Cards sharing a qualifier still order by session name before
the opaque sessionId. Under the default mode it returns null for every card, leaving that
sort as it was; every mode degrades to the bare repo name, never a dangling separator.

<!-- entry 196 -->
