# Windows sessions carry a durable claude.exe owner pid

Windows sessions now carry a DURABLE owner pid, fixing entry 101's fallback (a force-quit session
lingered ~6h). The SessionStart hook walks up to the nearest claude.exe and logs an `OwnerResolved`
event; a verified pid is never overwritten by the event stream, and only a verified pid counts as
reaper evidence on Windows. It must run INSIDE the hook — once it exits the chain is gone.
Costs ~170ms via a wmic process-table snapshot walked in pure JS; PowerShell measured ~1.1s (fallback).

<!-- entry 107 -->
