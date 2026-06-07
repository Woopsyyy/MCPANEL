# MCPANEL — Native Windows Setup Automation

**Date:** 2026-06-08
**Status:** Approved (design)

## Problem

MCPANEL runs cleanly on WSL, where the author has already configured Node, Java
(Temurin 25), and a server folder. A non-techy person who wants to run a
Minecraft server on a plain **Windows** machine (cmd / PowerShell, no WSL) has no
smooth path: they must manually install Node, install a JDK, run
`npm install -g @woopsy/mcpanel`, and fix PATH issues. We want a near one-click
experience on native Windows.

## Goal

A non-techy Windows user double-clicks one file and ends up with a working
`mcpanel` they can run, with Node, Java 25, and mcpanel all installed
automatically. The CLI itself also handles a missing JDK gracefully, so even
someone who installed via plain `npm i -g` gets walked through Java on first
`start`.

## Non-goals (YAGNI)

- No WSL auto-install or "install WSL too" path. Native Windows only.
- No Git install (not required for an npm-global install).
- No new installer for macOS / Linux — those already work via `npm i -g`.
- The reported `InvalidAgentKey` playit tunnel error is **out of scope** — that is
  a stale agent secret (a `tunnel reset` concern), unrelated to Windows setup.

## Key constraints discovered

1. **Bootstrap chicken-and-egg.** mcpanel is a Node program, so the CLI cannot be
   the thing that installs Node — Node must exist before the CLI can run.
   Therefore Node + mcpanel installation must live in a launcher that runs
   *before* Node exists. Java is only needed to *start* a server, not to run the
   CLI, so the CLI itself can detect and install Java.
2. **`findInstalledJavas()` is Linux/macOS only** (`src/utils/helpers.ts:238`). On
   native Windows it scans `/usr/lib/jvm` etc. and finds nothing, so `/java` and
   the info block show "not found" on Windows today. This must gain Windows roots
   regardless of the launcher.
3. **Java↔MC coupling.** Minecraft 26.x needs **Java 25** (class file v69). The
   installer targets Temurin 25 (`EclipseAdoptium.Temurin.25.JDK`).
4. **`winget`** ships on Windows 10 1809+ and Windows 11. If absent (older Win10),
   the launcher must degrade to a friendly message with manual download links and
   the npm command — never hard-crash.

## Architecture — two layers

### Layer 1 — Windows launcher (runs before Node exists)

Files: `scripts/win/mcpanel-setup.bat`, `scripts/win/mcpanel-setup.ps1`.

- **`mcpanel-setup.bat`** — the double-click target for non-techy users. A thin
  wrapper that invokes the PowerShell script bypassing execution policy:
  `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mcpanel-setup.ps1"`.
- **`mcpanel-setup.ps1`** — the real installer. **Idempotent**; every step is
  skipped when already satisfied. Steps:
  1. Detect `winget`. If missing: print a friendly explanation + manual download
     links (Node LTS, Temurin 25) + `npm install -g @woopsy/mcpanel`, then exit
     gracefully (no stack trace).
  2. If `node -v` is missing or `< 22`: `winget install OpenJS.NodeJS.LTS`
     (silent, accept agreements).
  3. If no Java 25 detected: `winget install EclipseAdoptium.Temurin.25.JDK`.
  4. Refresh the in-session `$env:Path` from the machine + user registry so
     freshly installed `node`/`npm` resolve without reopening the shell.
  5. `npm install -g @woopsy/mcpanel`.
  6. Create a Start-menu shortcut and a Desktop shortcut named **MCPANEL** that
     opens a new console running `mcpanel`.
  7. Launch `mcpanel`.
- Doubles as the `irm https://raw.githubusercontent.com/Woopsyyy/MCPANEL/main/scripts/win/mcpanel-setup.ps1 | iex`
  one-liner for PowerShell users.

UAC: `winget` package installs may prompt for elevation per package; that is
acceptable. The npm global install writes to the user profile and needs no admin.

### Layer 2 — CLI native-Windows Java support

File: `src/utils/helpers.ts`.

- **Extend `findInstalledJavas()`** with Windows search roots:
  - `C:\Program Files\Eclipse Adoptium\*\bin\java.exe`
  - `C:\Program Files\Java\*\bin\java.exe`
  - `%JAVA_HOME%\bin\java.exe`
  - `where java` (first hit on PATH)
  - Keep the existing newest-first sort (`parseInt` on leading version number).
- **Add `ensureJavaInstalled()`** — Windows-only helper. If no JDK is found, run
  `winget install EclipseAdoptium.Temurin.25.JDK`, then re-detect and return the
  resolved path so the caller can persist `config.defaultJavaPath`.

### Layer 3 — CLI hook (in-app Java guard)

Files: `src/index.ts`, `src/commands/commandRouter.ts`.

- Before `executeStart()` runs, if on Windows and no Java is detected, prompt
  `Java 25 not found. Install it now? (y/n)` using the existing readline pattern
  (a small confirm state, mirroring the wizard states already in `index.ts`). On
  `y`, call `ensureJavaInstalled()`, persist `defaultJavaPath`, then proceed; on
  `n`, abort the start with a clear message.
- The info block already shows `java: not found` in red (`index.ts:103`); leave
  the text, but the new detection means it will correctly find a Windows JDK once
  one is installed.

### Layer 4 — Docs

File: `README.md`.

- Add a **"🪟 Windows (one-click, no WSL)"** section above the existing manual
  cmd/PowerShell instructions: download + double-click `mcpanel-setup.bat`, or
  paste the `irm … | iex` one-liner. Keep the existing manual `npm i -g`
  instructions as the "advanced" fallback.

## Testing / verification

- **PowerShell script**: cannot run on this Linux/WSL dev box, so verify by (a)
  static review of the `.ps1` for syntax via `pwsh -NoProfile -Command` parse if
  `pwsh` is available, otherwise (b) careful review against winget/PATH idioms.
  Manual smoke test on a Windows machine is the real gate (document the steps).
- **`findInstalledJavas()` Windows roots**: unit-style check is awkward without a
  Windows FS; verify the path-globbing logic is guarded so it is a no-op on
  Linux/WSL (must not regress the existing `/usr/lib/jvm` scan). Build with `tsc`
  and confirm `/java` still works on WSL.
- **Java guard**: verify the new confirm state integrates with the readline state
  machine without breaking existing wizard flows (`WIZARD_SYNC_PATH` etc.).
- Run `npm run build` (tsc) — must compile clean.

## Files touched

- `scripts/win/mcpanel-setup.bat` (new)
- `scripts/win/mcpanel-setup.ps1` (new)
- `src/utils/helpers.ts` (Windows Java detection + `ensureJavaInstalled`)
- `src/index.ts` (Java confirm state + guard before start)
- `src/commands/commandRouter.ts` (wire the guard into the start path)
- `README.md` (Windows one-click section)
- `package.json` `files` whitelist — add `scripts/win` only if we want the
  launcher shipped in the npm tarball (decision: ship via GitHub raw + repo, not
  the tarball, to keep the package small — so **no** package.json change needed).
