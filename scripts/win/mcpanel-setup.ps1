#Requires -Version 5.1
<#
  MCPANEL one-click setup for native Windows (no WSL).
  Installs Node LTS + Temurin 25 JDK + @woopsy/mcpanel via winget,
  creates shortcuts, then launches mcpanel. Idempotent and best-effort.
#>

$ErrorActionPreference = 'Stop'

function Write-Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  !!  $msg" -ForegroundColor Yellow }

function Refresh-Path {
  # Rebuild this session's PATH from machine + user scopes so freshly
  # installed node/npm resolve without reopening the shell.
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = ($machine, $user | Where-Object { $_ }) -join ';'
}

function Has-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host ""
Write-Host "  MCPANEL — Windows Setup" -ForegroundColor Green
Write-Host "  ----------------------" -ForegroundColor DarkGray
Write-Host ""

# 1. winget availability ------------------------------------------------------
if (-not (Has-Command 'winget')) {
  Write-Warn2 "winget was not found (needs Windows 10 1809+ or Windows 11)."
  Write-Host ""
  Write-Host "  Install these manually, then re-run, or run the npm command:" -ForegroundColor Yellow
  Write-Host "    Node.js LTS : https://nodejs.org/en/download" -ForegroundColor Gray
  Write-Host "    Java 25     : https://adoptium.net/temurin/releases/?version=25" -ForegroundColor Gray
  Write-Host "    Then        : npm install -g @woopsy/mcpanel" -ForegroundColor Gray
  Write-Host ""
  Read-Host "Press Enter to close"
  exit 1
}
Write-Ok "winget found"

# 2. Node.js >= 22 ------------------------------------------------------------
Write-Step "Checking Node.js (need >= 22)"
$needNode = $true
if (Has-Command 'node') {
  $nodeVer = (& node -v) -replace '^v',''
  $major = [int]($nodeVer.Split('.')[0])
  if ($major -ge 22) { $needNode = $false; Write-Ok "Node $nodeVer already installed" }
  else { Write-Warn2 "Node $nodeVer is too old" }
}
if ($needNode) {
  Write-Step "Installing Node.js LTS via winget"
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
  Refresh-Path
  if (Has-Command 'node') { Write-Ok ("Node " + ((& node -v) -replace '^v','') + " installed") }
  else { Write-Warn2 "Node still not on PATH — you may need to reopen the terminal." }
}

# 3. Java 25 (Temurin) --------------------------------------------------------
Write-Step "Checking Java 25"
$needJava = $true
if (Has-Command 'java') {
  $jv = (& java -version 2>&1 | Out-String)
  if ($jv -match '"?(\d+)') { if ([int]$Matches[1] -ge 25) { $needJava = $false; Write-Ok "Java 25+ already installed" } }
}
if ($needJava) {
  Write-Step "Installing Eclipse Temurin 25 JDK via winget"
  winget install --id EclipseAdoptium.Temurin.25.JDK -e --silent --accept-source-agreements --accept-package-agreements
  Refresh-Path
  Write-Ok "Temurin 25 install attempted"
}

# 4. mcpanel ------------------------------------------------------------------
Write-Step "Installing @woopsy/mcpanel (global)"
& npm install -g "@woopsy/mcpanel"
Refresh-Path
Write-Ok "mcpanel installed"

# 5. Shortcuts ----------------------------------------------------------------
Write-Step "Creating shortcuts"
try {
  $mcpanelCmd = (Get-Command mcpanel -ErrorAction SilentlyContinue).Source
  $target = if ($mcpanelCmd) { $mcpanelCmd } else { "$env:APPDATA\npm\mcpanel.cmd" }
  $ws = New-Object -ComObject WScript.Shell
  foreach ($dir in @([Environment]::GetFolderPath('Desktop'),
                     (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
    $lnk = $ws.CreateShortcut((Join-Path $dir 'MCPANEL.lnk'))
    $lnk.TargetPath = "$env:SystemRoot\System32\cmd.exe"
    $lnk.Arguments  = "/k `"$target`""
    $lnk.IconLocation = "$env:SystemRoot\System32\cmd.exe,0"
    $lnk.Save()
  }
  Write-Ok "Desktop + Start-menu shortcuts created"
} catch {
  Write-Warn2 "Could not create shortcuts: $($_.Exception.Message)"
}

# 6. Launch -------------------------------------------------------------------
Write-Host ""
Write-Ok "Setup complete. Launching MCPANEL..."
Write-Host ""
& mcpanel
