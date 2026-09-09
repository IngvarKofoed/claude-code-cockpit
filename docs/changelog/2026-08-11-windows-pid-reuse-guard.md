# Windows ancestor walk guards against pid reuse

The Windows ancestor walk guards pid REUSE with `CreationDate` (v0.36.0) —
`Win32_Process` keeps reporting a `ParentProcessId` after the parent exits, so without the
check a recycled pid could raise an unrelated app's window. PowerShell is invoked as base64
`-EncodedCommand` (a fixed script + an integer-validated pid), which removes command-line
quoting from the picture entirely — the scripts embed C# needing double quotes.
Not verified on real Windows: written and unit-tested from macOS.

<!-- entry 96 -->
