# Windows Terminal focus works via UI Automation

Windows terminal focus WORKS, via UI Automation (v0.38.0) — entry 102's "can never address a
background tab" is WRONG and superseded. The daemon enumerates Windows Terminal tabs through UIA,
Selects the matching one, and raises the window; verified 4/4 against a real background tab.
Entry 102 remains right about PROCESS traversal — that stays a dead end, do not re-attempt it.
UIA exposes no link to the hosted shell either (every TabItem reports the WindowsTerminal.exe pid).

<!-- entry 104 -->
