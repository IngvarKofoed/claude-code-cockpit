# .gitattributes pins line endings for install scripts

New `.gitattributes` pins `*.sh` to LF and `*.cmd`/`*.bat`/`*.ps1` to CRLF on checkout.
Previously nothing did, so correctness rode on each committer's `core.autocrlf`: one without it
would commit a CRLF `install.sh`, which dies on Linux/macOS with `bad interpreter: …^M`.
Git Bash tolerates CRLF, so that breakage would only ever surface for other people.

<!-- entry 100 -->
