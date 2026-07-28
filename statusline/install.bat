@echo off
REM Thin wrapper -- the installer itself is install.js, which is cross-platform.
REM See install.js for what it does and why.
REM
REM install.cmd and install.bat are byte-identical: cmd.exe treats the two
REM extensions the same, but which one people reach for differs, so both exist.

where node >nul 2>nul
if errorlevel 1 (
  echo error: 'node' is not on PATH; the statusline needs Node.js to run. 1>&2
  exit /b 1
)

node "%~dp0install.js" %*
exit /b %ERRORLEVEL%
