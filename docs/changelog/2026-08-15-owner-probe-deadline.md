# Owner probe deadline now spans both wmic and PowerShell stages

The owner probe no longer blows through SessionStart's exit guard (v0.38.0, review fix). One
deadline now spans BOTH stages — a slow wmic followed by a full-budget PowerShell fallback used to
run ~6s against a 4s guard, stalling the hook AND recording nothing. Ceiling cut 3000→1200ms
(measured ~200ms). `ensureDeps()` runs BEFORE the probe: its first-run `spawnSync('npm install')`
blocks the loop long enough to expire a probe started beforehand. And a TTY stdin is skipped —
`commands/open.md` tells users to run ensure.js directly, where the read would hang forever.

<!-- entry 112 -->
