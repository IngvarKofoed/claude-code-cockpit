# Tracking marker written last, after snapshot persists

That marker is written LAST in the daemon's boot sequence, because it now persists the
snapshot immediately (reconcile()'s append→save pairing), so a daemon dying inside the 5s
save interval can't append a duplicate next boot. Do NOT move the call earlier: dropping
ended sessions, catchUpIngest and the pause fold must all have settled first, or that
write captures a half-booted picture.

<!-- entry 202 -->
