# Windows Terminal focus confirmed non-functional via process walk

Windows terminal focus is CONFIRMED NON-FUNCTIONAL on a default Windows 11 setup, and the parent
walk cannot fix it — the window belongs to `WindowsTerminal.exe` parented to `svchost.exe` by the
default-terminal handoff, so it is outside the session's process tree in both directions.
Entry 93's claim that a legacy `cmd.exe`/`pwsh` console "focuses exactly" is WRONG for Windows 11:
that console is a `0x4` ConPTY shim owning no window. Do not re-attempt via process traversal.
The only signal reaching the real window is the WT title, which tracks the ACTIVE TAB — so it can
never address a background tab, i.e. exactly the case the button exists for.

<!-- entry 102 -->
