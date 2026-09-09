# Config tests derive fixture path from paths.configPath

The config tests derive their fixture path from `paths.configPath()` instead of hand-building
the POSIX XDG layout (v0.41.0), so they exercise the real file on Windows too, where
`configDir()` reads APPDATA. One test was merely RED there. The malformed-json one was worse:
it passed VACUOUSLY, asserting the defaults a MISSING file already returns, so the never-throws
branch it exists to cover had never run on Windows. Confirmed by mutation; an existsSync pins it.

<!-- entry 125 -->
