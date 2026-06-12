# MCPANEL Dashboard — Design Spec

Date: 2026-06-12

## Goal

Add a `dashboard` command to the MCPANEL CLI that launches a local web dashboard
(React + Vite frontend, Node.js + Fastify backend, WebSocket realtime) for
visually monitoring and managing the single connected Minecraft server.

## Decisions

- **Distribution:** Prebuilt bundle shipped inside the npm package. `dashboard`
  boots Fastify on localhost and opens the browser. No git clone, no build on the
  user's machine.
- **Scope:** Phased. Phase 1 = core; Phase 2 = drag-drop upload, scheduled/auto
  backups, tunnel management, charts.
- **Security:** Bind 127.0.0.1 only + a random per-launch token baked into the
  auto-opened URL, required on every REST call and the WS handshake.

## Architecture

The CLI is already a long-lived Node process owning the live state (server child
process + stdout, playit relay, console callbacks, managers). The Fastify + WS
server runs **in that same process**, wired to the *same manager instances*, so
the browser sees the exact same console stream and tunnel state as the terminal.

```
mcpanel CLI process
  ConfigManager / ServerManager / BackupManager / ProcessManager / PlayitManager
        │ (same instances)
  DashboardServer = Fastify (REST) + WebSocket + @fastify/static
        │ 127.0.0.1:<port>?token=…
  Browser (React)  ← opened automatically
```

The terminal shell stays usable while the dashboard runs. `dashboard stop` shuts
it down.

## Backend (`src/dashboard/`)

- `DashboardServer` — constructed with the existing managers + router (same DI
  pattern as `CommandRouter`).
- Libraries: `fastify`, `@fastify/websocket` (native ws), `@fastify/static`.
- **REST (token-guarded):** `GET /api/overview`, `/api/players`, `/api/content`
  (mods or plugins by software), `/api/tunnels`, `/api/backups`; `POST
  /api/server/{start,stop,restart}`, `POST /api/backups`,
  `POST /api/backups/:id/restore`.
- **WebSocket `/ws`:** server→client `console` / `playit` / `players` / `status`
  (2s tick); client→server `command` → `processManager.sendCommand`.

### Realtime feeds

- **Players online:** subscribe to ProcessManager stdout; parse
  `joined the game` / `left the game`; reconcile every ~15s via `list`.
- **Mods/plugins:** scan `<server>/mods/*.jar` (Fabric/Forge) or
  `<server>/plugins/*.jar` (Paper/Spigot); read `fabric.mod.json` / `plugin.yml`
  from each jar with `adm-zip` for real name + version.
- **Tunnels:** `PlayitManager.getRunData(secret).tunnels`.
- **Console / playit logs:** existing stdout + `registerTunnelStream` hooks,
  fanned out to WS subscribers (ProcessManager/PlayitManager gain a fan-out
  subscribe API alongside the existing single-callback API used by the terminal).

## Frontend (`dashboard/client/`)

React + Vite + TypeScript + Tailwind. Dark, terminal-inspired developer-console
admin panel; bento-grid overview. Extends the CLI's neofetch identity.

- **Color:** zinc-950 bg, zinc-900 cards, zinc-800 borders, grass-green primary,
  semantic success/warn/error (never color-alone).
- **Type:** Inter (UI) + JetBrains Mono (console/logs/stats), tabular-nums on
  metrics.
- **Icons:** Lucide. **Motion:** 150–300ms transform/opacity, respects
  `prefers-reduced-motion`. Skeletons on load. WS auto-reconnect banner.
- **Nav:** sidebar (Overview · Players · Content · Tunnels · Console · Backups),
  top bar with server name + status pill + start/stop/restart.

## Packaging

- `dashboard/client/` Vite app with its own package.json.
- `npm run build:dashboard` → `vite build` → `dist/dashboard/public/`.
- Hooked into `prebuild`/`build`; `dist/dashboard` added to package `files`.
- Runtime: `@fastify/static` serves `dist/dashboard/public`; browser opened via
  existing `openInBrowser`.
- **Playit gate:** `dashboard` ensures a claimed agent secret (real account)
  before starting.

## Phasing

- **Phase 1 (this build):** in-process Fastify+WS, `dashboard` / `dashboard stop`,
  overview, players, mods/plugins list, tunnel status, live console (read+send),
  playit logs, manual backup/list/restore, token security, prebuilt packaging.
- **Phase 2:** drag-drop `.jar` upload, scheduled + save-safe automatic backups,
  tunnel create/stop, charts/sparklines.
