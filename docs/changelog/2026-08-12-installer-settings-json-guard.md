# Installer refuses to write an unparsable settings.json

The installer now REFUSES to write when an existing `settings.json` doesn't parse, where the old
`install.sh` reset it to `{}` and rewrote. Clobbering the user's global settings over a stray
trailing comma is worse than making them fix one character; a backup only helps if noticed.
Its idempotency check also folds case on Windows — the drive letter varies by invoking shell
(`C:\` from cmd, `c:/` from Git Bash), so a re-run via another wrapper looked like a change.

<!-- entry 99 -->
