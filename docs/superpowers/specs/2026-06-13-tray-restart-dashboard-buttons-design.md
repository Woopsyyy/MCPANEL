# Tray: Restart Server & Open Dashboard buttons

**Date:** 2026-06-13
**Status:** Approved

## Goal

Add two items to the MCPANEL system tray menu:

1. **Restart Server** — stops then starts the managed server.
2. **Open Dashboard** — launches/opens the web dashboard in the browser.

Also confirm and preserve the existing guarantee that **only the Exit item closes
the tray** — no other menu action terminates it.

All work is in `src/managers/trayManager.ts` with one wiring change in
`src/index.ts`.

## Menu layout

```
Open Console / Hide Console
──────────
Server: <status>
Start/Stop Server
Restart Server        ← new (disabled/greyed when server is offline)
──────────
Tunnel: <status>
Start/Stop Tunnel
──────────
Open Dashboard        ← new
──────────
Exit
```

## New menu-item state

- `itemServerRestart = { title: 'Restart Server', tooltip: 'Stop and start the server', enabled: false }`
- `itemOpenDashboard = { title: 'Open Dashboard', tooltip: 'Open the web dashboard in your browser', enabled: true }`

## Behavior

### Restart Server
- Enabled only when the server is running; greyed out when offline (decided).
- Action: `await stopServerFromTray()` then `await startServerFromTray()`, then
  `updateMenu()`.
- Race-free: `ProcessManager.stopServer()` resolves on the process `exit` event,
  so the old process has fully exited before the new one starts (no port clash).

### Open Dashboard
- `TrayManager` gains one constructor dependency: a callback
  `onOpenDashboard: () => Promise<void>`.
- `index.ts` passes `() => handleDashboardCommand('')`, so a tray click runs the
  **exact same** flow as typing `dashboard`: if not running it performs the
  playit account-link / browser-approval flow (printed to console, browser opened
  for approval) then starts and opens the tab; if already running it just reopens
  the browser tab.
- The tray handler wraps the callback in try/catch so a failure logs instead of
  throwing through the click handler.

### Tray close guarantee
- Only the `Exit` branch calls `tray.kill()`. The two new handlers return
  normally and never call `process.exit`, so the tray persists until Exit.
- A code comment documents that Exit is the sole kill path.

## Refactor (avoid duplication)

The existing `Start Server` branch contains inline jar-resolution +
`processManager.startServer(...)`. Extract it into a private
`startServerFromTray()`; extract the stop into `stopServerFromTray()`. The
`Start Server` / `Stop Server` click branches and the new `Restart Server` branch
all call these helpers.

## updateMenu changes

Set `itemServerRestart.enabled = running` and push a single
`{ type: 'update-item', item: this.itemServerRestart }` action — consistent with
how the existing items refresh. `itemOpenDashboard` is static (no per-tick update).

## Testing

Extend `scratch/testTray.ts` to construct `TrayManager` with a stub
`onOpenDashboard`, mount the menu, and assert:
- The new items render in the menu.
- `Restart Server` is disabled when no server is active and enabled when one is.

No real Minecraft server or live dashboard is required.

## Out of scope

- No changes to dashboard launch logic, the account gate, or `serverManager`.
- No new config options.
