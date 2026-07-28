# Thin wrapper — the installer itself is install.js, which is cross-platform.
# See install.js for what it does and why.
#
# Usage:  powershell -ExecutionPolicy Bypass -File statusline\install.ps1
# (The -ExecutionPolicy flag avoids the default block on unsigned scripts; the
# .cmd/.bat wrappers sidestep script policy entirely if you prefer.)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "'node' is not on PATH; the statusline needs Node.js to run."
    exit 1
}

& node (Join-Path $PSScriptRoot 'install.js') @args
exit $LASTEXITCODE
