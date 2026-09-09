# Account switch stamps liveAccountSince per observed switch

An observed CHANGE of the organizationUuid stamps `liveAccountSince` — per switch, not per
id, so an A→B→A flip-back re-stamps (a per-id memory would file B's numbers under A). Only
known→known counts, so a transiently unreadable file is not a switch. A first-ever
observation deliberately does NOT stamp: nothing has been observed to change, and stamping
would drop every idle session's re-push at the upgrade seam. `{id, since}` is snapshotted.

<!-- entry 186 -->
