@echo off
REM MCPANEL one-click setup — double-click me.
REM Runs the PowerShell installer bypassing execution policy for this run only.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mcpanel-setup.ps1"
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo Setup did not finish cleanly. See the messages above.
  pause
)
