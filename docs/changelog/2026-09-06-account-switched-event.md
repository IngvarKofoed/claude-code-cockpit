# Account switches are now durably logged and counted

Every observed account switch is now durable: the daemon appends an `AccountSwitched` event,
counted into the rollup's new TOP-LEVEL `accountSwitches` (top-level because a switch has no
repo — the account is one global). Reuses the sanctioned session-less writer path
(Paused/Resumed). No direct fold: the tail counts the line, so a boot rescan and the live
path stay arithmetically identical. A FLOOR — an A→B→A flip between two reads is invisible.

<!-- entry 199 -->
