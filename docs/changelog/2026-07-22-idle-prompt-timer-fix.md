# Fixed runaway prompt timer in idle-prompt guard

Fixed a runaway prompt timer in the `idle_prompt` lost-Stop guard (entry 10): it flipped status to idle
but never cleared `currentPrompt`, so the browser ticked the elapsed timer forever under an Idle badge.
It now actually closes the turn (clears currentPrompt + records the duration), matching the guard's intent.

<!-- entry 13 -->
