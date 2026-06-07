# Native Windows Setup Automation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-techy Windows user double-click one file to get Node + Temurin 25 + mcpanel installed and running, and have the CLI itself detect/install Java on native Windows.

**Architecture:** A `winget`-based PowerShell installer (with a `.bat` double-click wrapper) handles the cold start where Node does not yet exist. The CLI gains native-Windows Java detection in `findInstalledJavas()`, a `winget`-based `installTemurin25()` helper, and a `start`-time confirm-and-install guard wired into the existing readline state machine.

**Tech Stack:** TypeScript (tsc, CommonJS), Node ≥22, PowerShell + `winget` (Windows), `readline` state machine.

**Verification note:** This repo has **no unit-test runner** and the new code is **Windows-only / PowerShell**, neither of which executes on the Linux/WSL dev box. So "tests" in this plan mean: (a) `npx tsc --noEmit` must pass, (b) `node -e` sanity runs against the built output must not crash and must preserve existing WSL behavior, and (c) the PowerShell script and Windows code paths get a **documented manual smoke test** on a real Windows machine (Task 7). This is the honest, pragmatic gate given the constraints — do not fabricate passing Windows results.

---

### Task 1: Windows PowerShell installer

**Files:**
- Create: `scripts/win/mcpanel-setup.ps1`
- Create: `scripts/win/mcpanel-setup.bat`

- [ ] **Step 1: Write the PowerShell installer**

Create `scripts/win/mcpanel-setup.ps1`:

```powershell
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
```

- [ ] **Step 2: Write the double-click .bat wrapper**

Create `scripts/win/mcpanel-setup.bat`:

```bat
@echo off
REM MCPANEL one-click setup — double-click me.
REM Runs the PowerShell installer bypassing execution policy for this run only.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mcpanel-setup.ps1"
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo Setup did not finish cleanly. See the messages above.
  pause
)
```

- [ ] **Step 3: Static review (no pwsh on this box)**

`pwsh` is not installed here, so parse-verify is unavailable. Review the script by eye against this checklist and confirm each:
- `winget` absence path prints links and exits 1 (no stack trace).
- Every `winget install` uses `--accept-source-agreements --accept-package-agreements`.
- `Refresh-Path` runs after each install that adds to PATH.
- The `.bat` quotes `%~dp0mcpanel-setup.ps1` and pauses only on failure.

- [ ] **Step 4: Commit**

```bash
git add scripts/win/mcpanel-setup.ps1 scripts/win/mcpanel-setup.bat
git commit -m "feat(win): add winget-based one-click installer (.bat + .ps1)"
```

---

### Task 2: Native-Windows Java detection in `findInstalledJavas()`

**Files:**
- Modify: `src/utils/helpers.ts:238-273` (`findInstalledJavas`)

- [ ] **Step 1: Replace the function body with a platform-branched version**

In `src/utils/helpers.ts`, replace the whole `findInstalledJavas` function (currently lines 234-273) with:

```ts
/**
 * Best-effort discovery of installed Java runtimes. Scans Linux/macOS common
 * locations, and on Windows scans the Adoptium/Java install roots, %JAVA_HOME%,
 * and `where java`. Returns each working java binary with its version, newest
 * first.
 */
export function findInstalledJavas(): Array<{ path: string; version: string }> {
  const found = new Map<string, string>(); // path -> version

  const probe = (bin: string) => {
    if (found.has(bin)) return;
    try {
      if (fs.statSync(bin).isFile()) {
        const info = checkJava(bin);
        if (info.installed) found.set(bin, info.version);
      }
    } catch { /* not a file / not accessible */ }
  };

  if (process.platform === 'win32') {
    if (process.env.JAVA_HOME) {
      probe(`${process.env.JAVA_HOME}\\bin\\java.exe`);
    }
    const winRoots = [
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Java',
      'C:\\Program Files (x86)\\Java',
    ];
    for (const root of winRoots) {
      let entries: string[] = [];
      try { entries = fs.readdirSync(root); } catch { continue; }
      for (const entry of entries) {
        probe(`${root}\\${entry}\\bin\\java.exe`);
      }
    }
    // PATH fallback — `where java` lists every java.exe on PATH.
    try {
      const out = execSync('where java', { stdio: ['pipe', 'pipe', 'pipe'] })
        .toString().trim().split(/\r?\n/);
      for (const line of out) probe(line.trim());
    } catch { /* none on PATH */ }
  } else {
    const searchRoots = [
      '/usr/lib/jvm',
      '/usr/java',
      '/opt/java',
      '/Library/Java/JavaVirtualMachines',
    ];
    for (const root of searchRoots) {
      let entries: string[] = [];
      try { entries = fs.readdirSync(root); } catch { continue; }
      for (const entry of entries) {
        // Linux: <root>/<jdk>/bin/java ; macOS: <jdk>/Contents/Home/bin/java
        probe(`${root}/${entry}/bin/java`);
        probe(`${root}/${entry}/Contents/Home/bin/java`);
      }
    }
  }

  return Array.from(found.entries())
    .map(([path, version]) => ({ path, version }))
    // Sort by leading version number descending (newest JDK first).
    .sort((a, b) => parseInt(b.version, 10) - parseInt(a.version, 10));
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Build and sanity-run (WSL non-regression)**

Run:
```bash
npm run build && node -e "const h=require('./dist/utils/helpers'); console.log(JSON.stringify(h.findInstalledJavas()))"
```
Expected: prints a JSON array of the WSL-side JDKs (e.g. the Temurin 25 / Java 17 / 21 under `/usr/lib/jvm`) — proving the Linux branch still works and nothing throws.

- [ ] **Step 4: Commit**

```bash
git add src/utils/helpers.ts
git commit -m "feat(win): detect Windows JDKs (Adoptium/Java roots, JAVA_HOME, PATH)"
```

---

### Task 3: `installTemurin25()` helper

**Files:**
- Modify: `src/utils/helpers.ts` (add new exported function after `findInstalledJavas`)

- [ ] **Step 1: Add the installer helper**

Append to `src/utils/helpers.ts` (after `findInstalledJavas`, before `cleanJavaVersion`):

```ts
/**
 * Windows-only: installs Eclipse Temurin 25 JDK via winget, then re-detects the
 * newest installed JDK. Returns the resolved java binary + version, or null if
 * install/detection failed (or not on Windows). Best-effort — winget can exit
 * non-zero yet still succeed, so we always re-probe afterwards.
 */
export function installTemurin25(): { path: string; version: string } | null {
  if (process.platform !== 'win32') return null;
  try {
    execSync(
      'winget install --id EclipseAdoptium.Temurin.25.JDK -e --silent ' +
      '--accept-source-agreements --accept-package-agreements',
      { stdio: 'inherit' }
    );
  } catch { /* winget may exit non-zero; re-probe regardless */ }
  const found = findInstalledJavas();
  return found.length ? found[0] : null;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Build and confirm export exists**

Run:
```bash
npm run build && node -e "const h=require('./dist/utils/helpers'); console.log(typeof h.installTemurin25, h.installTemurin25())"
```
Expected: prints `function null` on WSL (non-Windows → returns null without running winget). No throw.

- [ ] **Step 4: Commit**

```bash
git add src/utils/helpers.ts
git commit -m "feat(win): add installTemurin25() winget helper"
```

---

### Task 4: Java confirm-and-install guard before `start`

**Files:**
- Modify: `src/index.ts:41-49` (`ShellState` type)
- Modify: `src/index.ts:15` (import)
- Modify: `src/index.ts` (`promptUser`, a new `needsJavaPrompt()` helper, the `start` case, and a new `handleLine` case)

- [ ] **Step 1: Extend imports and the state type**

In `src/index.ts`, change the helpers import (line 15) from:

```ts
import { detectOS, checkJava } from './utils/helpers';
```
to:
```ts
import { detectOS, checkJava, findInstalledJavas, installTemurin25 } from './utils/helpers';
```

Add `'CONFIRM_JAVA_INSTALL'` to the `ShellState` union (lines 41-49):

```ts
type ShellState =
  | 'COMMAND'
  | 'WIZARD_SYNC_PATH'
  | 'WIZARD_TUNNEL_TYPE'
  | 'PROPERTIES_SELECT'
  | 'PROPERTIES_INPUT'
  | 'CONSOLE'
  | 'LOG_VIEW'
  | 'TUNNEL_LOG_VIEW'
  | 'CONFIRM_JAVA_INSTALL';
```

- [ ] **Step 2: Add the `needsJavaPrompt()` helper**

Add this function in `src/index.ts` just above `function promptUser()` (around line 314):

```ts
/**
 * True only on native Windows when no usable Java is found anywhere — the
 * trigger for the in-app "install Java?" guard before starting a server.
 */
function needsJavaPrompt(): boolean {
  if (process.platform !== 'win32') return false;
  const cfg = configManager.getConfig();
  if (checkJava(cfg.defaultJavaPath).installed) return false;
  return findInstalledJavas().length === 0;
}
```

- [ ] **Step 3: Add the confirm prompt to `promptUser()`**

In `promptUser()` add a branch (after the `PROPERTIES_INPUT` branch, before the streaming branch):

```ts
  } else if (currentState === 'CONFIRM_JAVA_INSTALL') {
    rl.setPrompt(colors.bold('Install Java 25 now? (y/n): '));
    rl.prompt();
```

- [ ] **Step 4: Gate the `start` command**

In `handleCommandState`, replace the existing `case 'start':` block (lines 662-665):

```ts
    case 'start':
      console.log(colors.cyan('Starting server...'));
      console.log(await router.executeStart());
      break;
```
with:
```ts
    case 'start':
      if (needsJavaPrompt()) {
        currentState = 'CONFIRM_JAVA_INSTALL';
        console.log(colors.warning('Java 25 is required to start a server, but none was found on this Windows PC.'));
        promptUser();
        break;
      }
      console.log(colors.cyan('Starting server...'));
      console.log(await router.executeStart());
      break;
```

- [ ] **Step 5: Handle the confirm answer in `handleLine`**

In `handleLine`'s `switch (currentState)`, add a new case (after `case 'WIZARD_TUNNEL_TYPE'`, before `PROPERTIES_SELECT`):

```ts
    case 'CONFIRM_JAVA_INSTALL': {
      const ans = trimmed.toLowerCase();
      if (ans === 'y' || ans === 'yes') {
        console.log(colors.cyan('Installing Temurin 25 JDK via winget — this can take a few minutes...'));
        const result = installTemurin25();
        if (!result) {
          currentState = 'COMMAND';
          console.log(colors.failure('Could not install or find Java automatically. Install Temurin 25 from https://adoptium.net, then run start again.'));
          promptUser();
          break;
        }
        configManager.updateSettings({ defaultJavaPath: result.path });
        console.log(colors.success(`Java ${result.version} installed and selected.`));
        currentState = 'COMMAND';
        console.log(colors.cyan('Starting server...'));
        console.log(await router.executeStart());
        promptUser();
      } else {
        currentState = 'COMMAND';
        console.log(colors.info('Start cancelled — Java is required to run a server.'));
        promptUser();
      }
      break;
    }
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Build and confirm WSL behavior is unchanged**

Run:
```bash
npm run build && node -e "const h=require('./dist/utils/helpers'); console.log('win32 only guard; needsJavaPrompt is false on', process.platform)"
```
Expected: prints `... false on linux`. Then manually launch `npm run prod` on WSL, confirm `start` behaves exactly as before (the guard is `win32`-only, so it never fires here). Type `exit` to leave.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "feat(win): prompt to auto-install Java 25 before start when missing"
```

---

### Task 5: README — Windows one-click section

**Files:**
- Modify: `README.md` (Install section, around lines 48-78)

- [ ] **Step 1: Insert the one-click section above the manual cmd instructions**

In `README.md`, immediately after the `## Install` intro line (line 50) and before `### 🐧 WSL / Linux / macOS`, insert:

```markdown
### 🪟 Windows — one-click (no WSL, no commands)

The easiest path for a fresh Windows PC. This installs Node, Java 25, and MCPANEL for you, then launches it.

1. Download **`mcpanel-setup.bat`** and **`mcpanel-setup.ps1`** from
   [`scripts/win`](https://github.com/Woopsyyy/MCPANEL/tree/main/scripts/win) (keep them in the same folder).
2. Double-click **`mcpanel-setup.bat`**. Approve any Windows install prompts.
3. When it finishes, MCPANEL opens — and there's now an **MCPANEL** shortcut on your Desktop and Start menu.

Prefer PowerShell? Paste this one line instead:

```powershell
irm https://raw.githubusercontent.com/Woopsyyy/MCPANEL/main/scripts/win/mcpanel-setup.ps1 | iex
```

> Requires Windows 10 (1809+) or Windows 11 for `winget`. On older Windows, install [Node LTS](https://nodejs.org) and [Java 25](https://adoptium.net/temurin/releases/?version=25) manually, then run `npm install -g @woopsy/mcpanel`.

If Java is missing later, MCPANEL will offer to install it the first time you run `start`.

---
```

- [ ] **Step 2: Verify rendering**

Run: `grep -n "one-click" README.md`
Expected: matches the new heading line — confirms the block landed.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add Windows one-click install section"
```

---

### Task 6: Final build gate

**Files:** none (verification only)

- [ ] **Step 1: Clean build**

Run: `npm run build`
Expected: tsc completes with no errors; `dist/index.js` is chmod'd by postbuild.

- [ ] **Step 2: Smoke-run on WSL**

Run: `npm run prod`
Expected: banner renders, info block shows `java:` with the WSL JDK version (proving `findInstalledJavas` still works), prompt appears. Type `exit`.

- [ ] **Step 3: Commit (if any build artifacts/lockfile changed)**

```bash
git add -A
git commit -m "chore: build native Windows setup feature" || echo "nothing to commit"
```

---

### Task 7: Manual Windows smoke test (documented — run on a real Windows PC)

**Files:** none (manual verification; record results in the PR description)

This is the **real gate** for the Windows-only code that cannot run on this dev box. On a Windows 10 (1809+) or 11 machine **without** Node/Java:

- [ ] **Step 1:** Copy `scripts/win/mcpanel-setup.bat` + `mcpanel-setup.ps1` to the machine, double-click the `.bat`.
- [ ] **Step 2:** Confirm winget installs Node LTS and Temurin 25, `npm install -g @woopsy/mcpanel` runs, Desktop + Start-menu **MCPANEL** shortcuts appear, and `mcpanel` launches.
- [ ] **Step 3:** In a *second* scenario — a machine with Node but no Java — install via plain `npm i -g @woopsy/mcpanel`, run `mcpanel`, `sync` a server folder, then `start`. Confirm the `Install Java 25 now? (y/n)` prompt appears, `y` runs winget, Java is detected, and the server starts.
- [ ] **Step 4:** Confirm `java` (the command) now lists the detected Windows JDK under "Detected JVMs".
- [ ] **Step 5:** Record pass/fail for each step in the PR. Do not claim Windows success without having run this.

---

## Self-review notes

- **Spec coverage:** Layer 1 launcher → Task 1; Layer 2 `findInstalledJavas` Windows roots → Task 2; Layer 2 `ensureJavaInstalled` (named `installTemurin25` here) → Task 3; Layer 3 start-guard → Task 4; Layer 4 docs → Task 5; build/verify → Tasks 6-7. The spec's decision to **not** add `scripts/win` to `package.json` `files` is honored — no task touches `package.json` (launcher ships via GitHub raw, matching the README one-liner).
- **Naming consistency:** the spec referred to `ensureJavaInstalled()`; this plan implements it as **`installTemurin25()`** (clearer — it always installs Temurin 25). Tasks 3 and 4 use that single name consistently.
- **No placeholders:** every code step shows complete code; every run step has an expected result.
