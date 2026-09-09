# Pause gate and auto-pause now ship on by default

The pause gate now ships ON by default with auto-pause at 90% (v0.28.0): `pauseGateEnabled` default
true, `autoPauseFiveHourPct` default 90 — a session freezes when 5h usage hits 90%.
No CONFIG_VERSION migration, so a persisted explicit `false` (or a custom threshold) is never
overridden — a boolean can't distinguish a deliberate opt-out from the old default, and force-enabling
a tool-blocking gate on upgrade was judged too surprising. But "no migration" ≠ "fresh installs only":
the default reaches any config that merely OMITS the key (a fresh/config-less install OR an existing
minimal/hand-edited/migrated config.json), because both the daemon's merged config and the gate hook
fill an absent key from DEFAULT_CONFIG.
Required companion fix: the gate hook's light raw `pause.pauseGateEnabled()` now DEFAULT-FILLS an
absent key (or an absent file, ENOENT) to `DEFAULT_CONFIG.pauseGateEnabled` — without it a config-less
install would auto-pause + show PAUSED while the hook silently kept running tools (it couldn't see the
default). It still honors an explicit true/false and stays side-effect-free (no migration write).
Crucially it keeps the gate's FAIL-OPEN rule for the error path: a corrupt/unparseable or otherwise
unreadable config resolves to `false` (tools run), NOT the default — a blocking hook must never freeze
every session on a config it couldn't read, so fail-open outranks matching the daemon there.

<!-- entry 78 -->
