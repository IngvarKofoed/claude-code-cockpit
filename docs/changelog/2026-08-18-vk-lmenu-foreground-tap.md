# Window raise synthesises a VK_LMENU tap first

That raise now synthesises a VK_LMENU tap first (v0.41.0): after an input event Windows grants
this process foreground rights and the next `SetForegroundWindow` succeeds. Measured cold, the
alternatives ALL fail — plain SetForegroundWindow, `SwitchToThisWindow`, and `AttachThreadInput`
to the foreground thread (attach succeeds, the raise still doesn't). Accepted cost: the tap
lands on whatever is in front, where a lone ALT can pop a menu bar. Do not "simplify" it away.

<!-- entry 123 -->
