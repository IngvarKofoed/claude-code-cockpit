# Windows Terminal tab join key is the session title

Because of that, the join key is the session TITLE — so the button works only for a session with a
DISTINCT name. Un-renamed sessions all read the literal "✳ Claude Code" and resolve to
`ambiguous-tab`, whose toast names the fix (/rename), rather than raising a coin-flip tab; a
titleless session hides the button. The `wt:<title>` target is re-derived from live state on every
title change, deliberately NOT resolved-once like the tty/pid targets — /rename renames the tab too.

<!-- entry 105 -->
