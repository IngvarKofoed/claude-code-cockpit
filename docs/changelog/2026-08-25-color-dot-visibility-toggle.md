# Session colour dot gets its own show/hide toggle

The colour dot has its own Settings > Dashboard switch ("Show session colour"), default ON —
a per-browser `App.liveShow.color` localStorage pref like the other Live-card toggles, never
daemon config, so it neither PUTs nor pops a "Settings saved" toast. No handler change was
needed: the switch listener already derives the key from its `set-show-<key>` element id.
The dot still lives INSIDE the name line, so turning the session name off removes the dot with
it — stated in the switch's own description rather than left as a surprise.

<!-- entry 151 -->
