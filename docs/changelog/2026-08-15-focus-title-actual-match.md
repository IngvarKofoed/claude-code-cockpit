# focusTitle set only when a Windows Terminal tab matches

`focusTitle` is only set when a Windows Terminal tab ACTUALLY matches (v0.38.0, review fix) —
it was derived from the session title alone, so every named Windows session showed a Focus button
even under VS Code or conhost, where it could only ever fail. That broke this project's own rule
that an unfocusable session shows NO button rather than a broken one. Enumeration is cached ~15s so
a burst of sessions costs one probe. An AMBIGUOUS match still counts: the click explains /rename.

<!-- entry 111 -->
