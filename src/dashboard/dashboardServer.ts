import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { pipeline } from 'stream/promises';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import type { WebSocket } from 'ws';
import pidusage from 'pidusage';

import { ConfigManager, APP_ROOT } from '../config/configManager';
import { ProcessManager } from '../services/processManager';
import { ServerManager } from '../managers/serverManager';
import { BackupManager } from '../managers/backupManager';
import { PlayitManager } from '../managers/playitManager';
import { CommandRouter } from '../commands/commandRouter';
import { getSystemStats, getDiskInfo, getDirSize, checkJava, openInBrowser } from '../utils/helpers';
import { logger } from '../utils/logger';
import { scanContent, resolveContentDir } from './contentScanner';
import { PlayerTracker } from './playerTracker';
import { TpsTracker } from './tpsTracker';
import { BackupScheduler } from './backupScheduler';
import { downloadFile } from '../services/downloadService';
import * as os from 'os';

/** Strips ANSI colour codes so router messages read cleanly as JSON. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export interface DashboardHandle {
  url: string;
  port: number;
  token: string;
}

const PREFERRED_PORT = 8910;

export class DashboardServer {
  private app: FastifyInstance | null = null;
  private token = '';
  private port = 0;
  private sockets = new Set<WebSocket>();
  private statusTimer: NodeJS.Timeout | null = null;
  private playerTracker: PlayerTracker | null = null;
  private tpsTracker: TpsTracker | null = null;
  private unsubTunnel: (() => void) | null = null;
  private unsubConsole: (() => void) | null = null;
  private unsubState: (() => void) | null = null;
  private unsubTunnelStatus: (() => void) | null = null;
  private prevRunning = false;                 // for console-clear on stop
  private diskCache: { bytes: number; at: number } | null = null; // server folder size, cached

  constructor(
    private configManager: ConfigManager,
    private processManager: ProcessManager,
    private serverManager: ServerManager,
    private backupManager: BackupManager,
    private playitManager: PlayitManager,
    private router: CommandRouter,
    private backupScheduler: BackupScheduler,
  ) {}

  public isRunning(): boolean {
    return this.app !== null;
  }

  public getHandle(): DashboardHandle | null {
    if (!this.app) return null;
    return { url: `http://127.0.0.1:${this.port}/?token=${this.token}`, port: this.port, token: this.token };
  }

  /** Boots the in-process Fastify + WebSocket server, returns the open URL. */
  public async start(): Promise<DashboardHandle> {
    if (this.app) return this.getHandle()!;

    this.token = crypto.randomBytes(16).toString('hex');
    const app = Fastify({ logger: false });

    await app.register(fastifyWebsocket);

    // Tolerate empty-body JSON POSTs (our action endpoints take no payload) so an
    // `application/json` header with no body never produces a 400.
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      const text = (body as string)?.trim();
      if (!text) { done(null, {}); return; }
      try { done(null, JSON.parse(text)); } catch (err) { done(err as Error, undefined); }
    });

    // Drag-and-drop mod/plugin uploads (.jar only). 250 MB ceiling per file.
    // throwFileSizeLimit:false makes oversized files truncate (we detect + reject)
    // instead of throwing mid-stream.
    await app.register(fastifyMultipart, {
      throwFileSizeLimit: false,
      limits: { fileSize: 250 * 1024 * 1024, files: 20 },
    });

    // Token guard for the REST API (the SPA itself is served without a token;
    // it reads the token from its own URL and attaches it to every API call).
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      const token = (req.query as any)?.token || req.headers['x-mcpanel-token'];
      if (token !== this.token) {
        reply.code(401).send({ error: 'Invalid or missing token.' });
      }
    });

    this.registerRoutes(app);
    this.registerWebSocket(app);
    this.registerStatic(app);

    this.port = await this.listenOnFreePort(app, PREFERRED_PORT);
    this.app = app;

    this.startStreams();
    return this.getHandle()!;
  }

  /** Tears everything down: timers, stream subscriptions, sockets, server. */
  public async stop(): Promise<void> {
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
    if (this.playerTracker) { this.playerTracker.stop(); this.playerTracker = null; }
    if (this.tpsTracker) { this.tpsTracker.stop(); this.tpsTracker = null; }
    if (this.unsubTunnel) { this.unsubTunnel(); this.unsubTunnel = null; }
    if (this.unsubConsole) { this.unsubConsole(); this.unsubConsole = null; }
    if (this.unsubState) { this.unsubState(); this.unsubState = null; }
    if (this.unsubTunnelStatus) { this.unsubTunnelStatus(); this.unsubTunnelStatus = null; }
    this.backupScheduler.setListener(null);
    for (const s of this.sockets) { try { s.close(); } catch { /* ignore */ } }
    this.sockets.clear();
    if (this.app) { try { await this.app.close(); } catch { /* ignore */ } this.app = null; }
  }

  // ---------------------------------------------------------------------------
  // REST API
  // ---------------------------------------------------------------------------

  private registerRoutes(app: FastifyInstance): void {
    app.get('/api/overview', async () => this.buildOverview());

    app.get('/api/players', async () => ({
      players: this.playerTracker ? this.playerTracker.getPlayers() : [],
    }));

    app.get('/api/content', async () => {
      const server = this.configManager.getServer();
      if (!server) return { kind: 'plugins', exists: false, items: [] };
      return scanContent(server);
    });

    app.get('/api/tunnels', async () => ({
      tunnels: await this.playitManager.listTunnels(),
      status: this.playitManager.getStatus(),
    }));

    app.get('/api/backups', async () => ({
      backups: this.backupManager.listBackups().map((b) => ({
        id: b.id, serverName: b.serverName, sizeBytes: b.sizeBytes, createdAt: b.createdAt,
      })),
    }));

    app.post('/api/server/start', async () => ({ message: stripAnsi(await this.router.executeStart()) }));
    app.post('/api/server/stop', async () => ({ message: stripAnsi(await this.router.executeStop()) }));
    app.post('/api/server/restart', async () => ({ message: stripAnsi(await this.router.executeRestart()) }));

    // Save-safe even while the server runs (save-off → flush → zip → save-on).
    app.post('/api/backups', async () => ({ message: await this.backupScheduler.runOnce() }));
    app.post('/api/backups/:id/restore', async (req) => {
      const id = (req.params as any).id;
      return { message: stripAnsi(this.router.executeBackupRestore(id)) };
    });

    // --- Phase 2: content upload / delete -----------------------------------
    app.post('/api/content/upload', async (req, reply) => {
      const server = this.configManager.getServer();
      if (!server) { reply.code(400); return { error: 'No server connected.' }; }
      const { dir, kind } = resolveContentDir(server);
      fs.mkdirSync(dir, { recursive: true });

      const saved: string[] = [];
      const rejected: string[] = [];
      for await (const part of (req as any).files()) {
        const clean = path.basename(part.filename || '');
        if (!clean.toLowerCase().endsWith('.jar')) {
          rejected.push(clean || '(unnamed)');
          part.file.resume(); // drain the stream we're skipping
          continue;
        }
        await pipeline(part.file, fs.createWriteStream(path.join(dir, clean)));
        if (part.file.truncated) { // exceeded the size limit
          try { fs.unlinkSync(path.join(dir, clean)); } catch { /* ignore */ }
          rejected.push(`${clean} (too large)`);
          continue;
        }
        saved.push(clean);
      }
      const parts = [];
      if (saved.length) parts.push(`Installed ${saved.length} ${kind === 'mods' ? 'mod' : 'plugin'}${saved.length > 1 ? 's' : ''}: ${saved.join(', ')}`);
      if (rejected.length) parts.push(`Skipped ${rejected.length} (only .jar allowed): ${rejected.join(', ')}`);
      return { message: parts.join('. ') || 'Nothing uploaded.', saved, rejected };
    });

    app.delete('/api/content/:file', async (req, reply) => {
      const server = this.configManager.getServer();
      if (!server) { reply.code(400); return { error: 'No server connected.' }; }
      const { dir } = resolveContentDir(server);
      const clean = path.basename((req.params as any).file || '');
      if (!clean.toLowerCase().endsWith('.jar')) { reply.code(400); return { error: 'Only .jar files can be removed.' }; }
      const target = path.join(dir, clean);
      if (!fs.existsSync(target)) { reply.code(404); return { error: `${clean} not found.` }; }
      fs.unlinkSync(target);
      return { message: `Removed ${clean}.` };
    });

    // --- Phase 2: automatic backup schedule ---------------------------------
    app.get('/api/backups/schedule', async () => this.backupScheduler.getState());
    app.put('/api/backups/schedule', async (req) => {
      const body = (req.body as any) || {};
      const enabled = !!body.enabled;
      const intervalHours = Number(body.intervalHours) || 24;
      const maxBackups = body.maxBackups != null ? Number(body.maxBackups) : undefined;
      return this.backupScheduler.update(enabled, intervalHours, maxBackups);
    });

    // --- Phase 2: tunnel control --------------------------------------------
    app.post('/api/tunnels/create', async (req, reply) => {
      const type = ((req.body as any)?.type || '').toLowerCase();
      if (type !== 'java' && type !== 'bedrock') { reply.code(400); return { error: 'type must be "java" or "bedrock".' }; }
      if (!this.playitManager.getSecret()) {
        reply.code(400);
        return { error: 'Link your playit.gg account first (relaunch the dashboard to run the one-time setup).' };
      }
      try {
        const status = await this.playitManager.setupAndStart(type, {
          onStatus: (msg) => this.broadcast({ type: 'notice', data: msg }),
        });
        return { message: `${type === 'java' ? 'Java' : 'Bedrock'} tunnel online at ${status.address}:${status.port}`, status };
      } catch (err: any) {
        reply.code(500);
        return { error: `Failed to create tunnel: ${err.message}` };
      }
    });
    app.post('/api/tunnels/stop', async () => ({
      message: this.playitManager.stopTunnel() ? 'Tunnel stopped.' : 'No tunnel was running.',
    }));

    // --- Phase 3: settings (server.properties + display name + RAM) ----------
    app.get('/api/settings', async (_req, reply) => {
      const server = this.configManager.getServer();
      if (!server) { reply.code(400); return { error: 'No server connected.' }; }
      return this.buildSettings(server);
    });
    app.put('/api/settings', async (req, reply) => {
      const server = this.configManager.getServer();
      if (!server) { reply.code(400); return { error: 'No server connected.' }; }
      const b = (req.body as any) || {};
      const props: Record<string, string> = {};
      const map: Record<string, string> = {
        motd: 'motd', maxPlayers: 'max-players', difficulty: 'difficulty', gamemode: 'gamemode',
        pvp: 'pvp', onlineMode: 'online-mode', whitelist: 'white-list', enforceWhitelist: 'enforce-whitelist',
      };
      for (const [key, prop] of Object.entries(map)) {
        if (b[key] !== undefined) props[prop] = typeof b[key] === 'boolean' ? String(b[key]) : String(b[key]);
      }
      if (Object.keys(props).length) this.serverManager.updateServerProperties(props);
      if (typeof b.displayName === 'string' || typeof b.displayIcon === 'string') {
        const patch: any = { ...server };
        if (typeof b.displayName === 'string') patch.displayName = b.displayName.trim() || undefined;
        if (typeof b.displayIcon === 'string') {
          // Accept a small data-URL image only (guards config.json from bloat).
          const icon = b.displayIcon.trim();
          patch.displayIcon = icon && icon.startsWith('data:image/') && icon.length < 200000 ? icon : undefined;
        }
        this.configManager.setServer(patch);
      }
      this.pushStatus(); // reflect display-name/icon/properties changes immediately
      return { message: 'Settings saved.', settings: this.buildSettings(this.configManager.getServer()!) };
    });
    app.put('/api/server/ram', async (req, reply) => {
      const server = this.configManager.getServer();
      if (!server) { reply.code(400); return { error: 'No server connected.' }; }
      const gb = Math.round(Number((req.body as any)?.gb));
      const totalGB = Math.floor(os.totalmem() / 1024 ** 3);
      if (!gb || gb < 1) { reply.code(400); return { error: 'RAM must be at least 1 GB.' }; }
      if (gb > totalGB) { reply.code(400); return { error: `RAM exceeds available memory (max ${totalGB} GB).` }; }
      this.configManager.setServer({ ...server, ram: `${gb}G` });
      this.pushStatus(); // reflect the new allocation in the dashboard immediately
      return { message: `RAM set to ${gb} GB. It applies the next time the server starts.`, ram: `${gb}G` };
    });

    // --- Phase 3: playit account connect / scan / go online ------------------
    app.get('/api/playit/status', async () => ({
      linked: !!this.playitManager.getSecret(),
      relayRunning: this.playitManager.isAgentRunning(),
      tunnels: await this.playitManager.listTunnels(),
    }));
    app.post('/api/playit/connect', async (_req, reply) => {
      try {
        const res = await this.playitManager.connect({
          onClaimUrl: (url) => { openInBrowser(url); this.broadcast({ type: 'notice', data: `Approve the agent in your browser to link playit.gg: ${url}` }); },
          onStatus: (msg) => this.broadcast({ type: 'notice', data: msg }),
        });
        return { message: `playit.gg account linked. ${res.tunnels.length} tunnel(s) found.`, ...res };
      } catch (err: any) {
        reply.code(500);
        return { error: `Could not connect playit.gg: ${err.message}` };
      }
    });
    app.post('/api/playit/online', async (_req, reply) => {
      try {
        const status = await this.playitManager.goOnline({ onStatus: (msg) => this.broadcast({ type: 'notice', data: msg }) });
        return { message: `Relay online at ${status.address}:${status.port} — logs are now streaming.`, status };
      } catch (err: any) {
        reply.code(500);
        return { error: `Could not go online: ${err.message}` };
      }
    });

    // --- Phase 3: maintenance (sync server / backup location) ----------------
    app.post('/api/maintenance/sync-server', async (req, reply) => {
      const dir = (req.body as any)?.path;
      if (!dir || typeof dir !== 'string') { reply.code(400); return { error: 'A server folder path is required.' }; }
      try {
        const meta = this.serverManager.syncServer(dir);
        return { message: `Synced "${meta.name}" (${meta.software} ${meta.version}).`, server: meta };
      } catch (err: any) {
        reply.code(400);
        return { error: err.message };
      }
    });
    app.put('/api/maintenance/backup-location', async (req, reply) => {
      const dir = (req.body as any)?.path;
      if (!dir || typeof dir !== 'string') { reply.code(400); return { error: 'A backup folder path is required.' }; }
      try {
        fs.mkdirSync(dir, { recursive: true });
        this.configManager.setBackupLocation(dir);
        return { message: `Backup location set to ${this.configManager.getBackupLocation()}.`, backupLocation: this.configManager.getBackupLocation() };
      } catch (err: any) {
        reply.code(400);
        return { error: `Could not set backup location: ${err.message}` };
      }
    });
    app.post('/api/maintenance/install-geyser', async (_req, reply) => {
      const server = this.configManager.getServer();
      if (!server) { reply.code(400); return { error: 'No server connected.' }; }
      try {
        return await this.installGeyser(server);
      } catch (err: any) {
        reply.code(500);
        return { error: `Geyser install failed: ${err.message}` };
      }
    });
    app.get('/api/maintenance', async () => {
      const server = this.configManager.getServer();
      return {
        serverPath: server?.path || null,
        serverName: server?.name || null,
        backupLocation: this.configManager.getBackupLocation(),
      };
    });
  }

  /**
   * Downloads GeyserMC + Floodgate for the server's platform into mods/plugins
   * and writes a minimal Geyser config (Bedrock port 19132, Floodgate auth) so
   * Bedrock players can join. Best-effort: Geyser fills the rest of its config
   * on first start; Fabric also needs Fabric API installed.
   */
  private async installGeyser(server: any): Promise<{ message: string; installed: string[] }> {
    const sw = String(server.software).toLowerCase();
    // GeyserMC download "platform" id for this server software.
    const platform =
      /fabric/.test(sw) ? 'fabric' :
      /neoforge/.test(sw) ? 'neoforge' :
      /paper|spigot|purpur|bukkit/.test(sw) ? 'spigot' :
      /velocity/.test(sw) ? 'velocity' :
      /waterfall|bungee/.test(sw) ? 'bungeecord' : null;
    if (!platform) {
      throw new Error(`Geyser has no build for ${server.software}. Supported: Fabric, Paper/Spigot/Purpur, NeoForge, Velocity, BungeeCord.`);
    }

    const { dir } = resolveContentDir(server);
    fs.mkdirSync(dir, { recursive: true });

    // Resolve the concrete latest version+build from the GeyserMC API (the
    // official, always-updated source) so we download a direct URL instead of
    // relying on the `latest/latest` redirect.
    const dl = async (project: 'geyser' | 'floodgate', file: string) => {
      const apiBase = `https://download.geysermc.org/v2/projects/${project}`;
      const meta: any = await fetch(`${apiBase}/versions/latest/builds/latest`).then((r) => {
        if (!r.ok) throw new Error(`GeyserMC API returned ${r.status} for ${project}`);
        return r.json();
      });
      if (!meta?.downloads?.[platform]) {
        throw new Error(`${project} ${meta?.version || ''} has no ${platform} build.`);
      }
      const url = `${apiBase}/versions/${meta.version}/builds/${meta.build}/downloads/${platform}`;
      const tmp = path.join(dir, `${file}.tmp`);
      await downloadFile(url, tmp);
      fs.renameSync(tmp, path.join(dir, file));
      return meta.version as string;
    };

    const installed: string[] = [];
    const gVer = await dl('geyser', `Geyser-${platform}.jar`);
    installed.push(`Geyser-${platform}.jar (v${gVer})`);
    const fVer = await dl('floodgate', `floodgate-${platform}.jar`);
    installed.push(`floodgate-${platform}.jar (v${fVer})`);

    // Minimal Geyser config so Bedrock works with Floodgate out of the box. Only
    // written if absent — Geyser merges in defaults for everything else on start.
    const geyserCfgDir = platform === 'spigot'
      ? path.join(server.path, 'plugins', 'Geyser-Spigot')
      : path.join(server.path, 'config', `Geyser-${platform.charAt(0).toUpperCase()}${platform.slice(1)}`);
    const cfgPath = path.join(geyserCfgDir, 'config.yml');
    let configWritten = false;
    if (!fs.existsSync(cfgPath)) {
      try {
        fs.mkdirSync(geyserCfgDir, { recursive: true });
        fs.writeFileSync(cfgPath, [
          '# Generated by MCPANEL — Geyser fills remaining defaults on first start.',
          'bedrock:',
          '  address: 0.0.0.0',
          '  port: 19132',
          'remote:',
          '  address: auto',
          '  port: 25565',
          '  auth-type: floodgate',
          '',
        ].join('\n'), 'utf-8');
        configWritten = true;
      } catch { /* non-fatal — Geyser will generate its own config */ }
    }

    const notes: string[] = [`Installed ${installed.join(' + ')} into ${path.basename(dir)}/.`];
    if (configWritten) notes.push('Wrote a Geyser config (Bedrock port 19132, Floodgate auth).');
    if (platform === 'fabric') notes.push('Fabric needs the Fabric API mod installed too.');
    notes.push('Restart the server, then create a Bedrock tunnel for port 19132.');
    return { message: notes.join(' '), installed };
  }

  /** Reads the editable settings subset for the dashboard Settings view. */
  private buildSettings(server: any): any {
    const props = this.serverManager.readPropertiesFile(path.join(server.path, 'server.properties'));
    const totalMemGB = Math.floor(os.totalmem() / 1024 ** 3);
    const maxPlayersNum = parseInt(props['max-players'] || '20', 10) || 20;
    let contentCount = 0;
    try { contentCount = scanContent(server).items.length; } catch { /* ignore */ }
    // Recommended heap band from player capacity + installed content.
    const minGB = Math.max(1, Math.min(totalMemGB, Math.round(2 + 0.5 * Math.ceil(maxPlayersNum / 5) + 0.05 * contentCount)));
    const maxGB = Math.min(totalMemGB, minGB + 2);
    return {
      displayName: server.displayName || server.name,
      displayIcon: server.displayIcon || null,
      name: server.name,
      motd: props['motd'] || '',
      maxPlayers: props['max-players'] || '20',
      difficulty: props['difficulty'] || 'easy',
      gamemode: props['gamemode'] || 'survival',
      pvp: (props['pvp'] || 'true') === 'true',
      onlineMode: (props['online-mode'] || 'true') === 'true',
      whitelist: (props['white-list'] || 'false') === 'true',
      enforceWhitelist: (props['enforce-whitelist'] || 'false') === 'true',
      ram: server.ram,
      ramGB: parseInt(String(server.ram).replace(/[^0-9]/g, ''), 10) || 4,
      totalMemGB,
      recommended: { minGB, maxGB },
      contentCount,
      maxPlayersNum,
    };
  }

  /** Snapshot used by both GET /api/overview and the periodic status tick. */
  private async buildOverview(): Promise<any> {
    const server = this.configManager.getServer();
    const sys = getSystemStats();
    const tunnel = this.playitManager.getStatus();

    const tps = this.tpsTracker ? this.tpsTracker.getTps() : { tps: null, lagging: false, supported: false };
    const base: any = {
      server: server
        ? { name: server.name, displayName: server.displayName || server.name, icon: (server as any).displayIcon || null, path: server.path, software: server.software, version: server.version, ram: server.ram }
        : null,
      system: {
        cpuUsage: sys.cpuUsage,
        usedMemGB: sys.usedMemGB,
        totalMemGB: sys.totalMemGB,
        memUsagePct: sys.memUsagePct,
        uptimeSeconds: sys.uptimeSeconds,
      },
      tunnel: { status: tunnel.status, address: tunnel.address, port: tunnel.port, latency: tunnel.latency, type: tunnel.type },
      players: this.playerTracker ? this.playerTracker.getPlayers() : [],
      running: false,
      process: null,
      serverDiskBytes: 0,
      health: [],
      performance: { tps: tps.tps, tpsSupported: tps.supported, lagging: tps.lagging, ping: tunnel.latency },
    };

    if (server) {
      const active = this.processManager.getActiveServer(server.name);
      base.running = !!active;
      if (active) {
        let cpu = 'N/A', ramMB = 'N/A';
        try {
          const stat = await pidusage(active.pid);
          cpu = stat.cpu.toFixed(1);
          ramMB = (stat.memory / (1024 * 1024)).toFixed(1);
        } catch { /* process may have just exited */ }
        base.process = { pid: active.pid, cpu, ramMB, uptimeMs: Date.now() - active.startTime };
      }
      base.serverDiskBytes = this.serverDiskSize(server.path);
      base.health = this.buildHealth(server, base);
    }
    return base;
  }

  /** Server folder size, recomputed at most every 30s (expensive on big worlds). */
  private serverDiskSize(serverPath: string): number {
    const now = Date.now();
    if (this.diskCache && now - this.diskCache.at < 30000) return this.diskCache.bytes;
    let bytes = 0;
    try { bytes = getDirSize(serverPath); } catch { /* ignore */ }
    this.diskCache = { bytes, at: now };
    return bytes;
  }

  /** Computes the health-check rows shown on the overview. */
  private buildHealth(server: any, ov: any): Array<{ id: string; label: string; status: string; detail: string }> {
    const out: Array<{ id: string; label: string; status: string; detail: string }> = [];

    out.push(ov.running
      ? { id: 'server', label: 'Server', status: 'ok', detail: 'Running' }
      : { id: 'server', label: 'Server', status: 'warn', detail: 'Offline' });

    // RAM headroom: allocated heap vs host RAM.
    const allocGB = parseFloat(String(server.ram).replace(/[^0-9.]/g, '')) || 0;
    const totalGB = ov.system.totalMemGB;
    const ramStatus = allocGB > totalGB ? 'danger' : allocGB >= totalGB - 1 ? 'warn' : allocGB > totalGB * 0.75 ? 'warn' : 'ok';
    out.push({ id: 'ram', label: 'RAM headroom', status: ramStatus, detail: `${allocGB} GB of ${totalGB} GB allocated` });

    // Free disk on the server's drive.
    const disk = getDiskInfo(server.path);
    if (disk) {
      const freeGB = disk.freeBytes / 1024 ** 3;
      const diskStatus = freeGB < 1 ? 'danger' : freeGB < 5 ? 'warn' : 'ok';
      out.push({ id: 'disk', label: 'Free disk', status: diskStatus, detail: `${freeGB.toFixed(1)} GB free` });
    }

    // Tunnel.
    out.push({
      id: 'tunnel', label: 'Tunnel',
      status: ov.tunnel.status === 'Online' ? 'ok' : ov.tunnel.status === 'Connecting' ? 'warn' : 'warn',
      detail: ov.tunnel.status,
    });

    // Java runtime.
    const java = checkJava(this.configManager.getConfig().defaultJavaPath);
    out.push({ id: 'java', label: 'Java', status: java.installed ? 'ok' : 'danger', detail: java.installed ? java.version : 'not found' });

    return out;
  }

  // ---------------------------------------------------------------------------
  // WebSocket hub
  // ---------------------------------------------------------------------------

  private registerWebSocket(app: FastifyInstance): void {
    app.get('/ws', { websocket: true }, (socket, req) => {
      const token = (req.query as any)?.token;
      if (token !== this.token) { try { socket.close(1008, 'Invalid token'); } catch { /* ignore */ } return; }

      this.sockets.add(socket);
      // Greet with an immediate snapshot so the UI paints without waiting a tick.
      this.buildOverview().then((ov) => this.sendTo(socket, { type: 'status', data: ov })).catch(() => { /* ignore */ });

      socket.on('message', (raw: Buffer) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg?.type === 'command' && typeof msg.command === 'string') {
          const server = this.configManager.getServer();
          if (server) this.processManager.sendCommand(server.name, msg.command);
        }
      });

      socket.on('close', () => { this.sockets.delete(socket); });
      socket.on('error', () => { this.sockets.delete(socket); });
    });
  }

  private sendTo(socket: WebSocket, payload: any): void {
    try { socket.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }

  private broadcast(payload: any): void {
    const data = JSON.stringify(payload);
    for (const s of this.sockets) {
      try { s.send(data); } catch { /* ignore */ }
    }
  }

  /** Immediately broadcasts a fresh overview snapshot to all clients. */
  private pushStatus(): void {
    if (this.sockets.size === 0) return;
    this.buildOverview().then((ov) => this.broadcast({ type: 'status', data: ov })).catch(() => { /* ignore */ });
  }

  /** Wires the live console/relay/player streams and the periodic status tick. */
  private startStreams(): void {
    const server = this.configManager.getServer();

    if (server) {
      this.unsubConsole = this.processManager.subscribeConsole(server.name, (chunk) => {
        this.broadcast({ type: 'console', data: chunk });
      });
      this.playerTracker = new PlayerTracker(this.processManager, server.name, (players) => {
        this.broadcast({ type: 'players', data: players });
      });
      this.playerTracker.start();
      this.tpsTracker = new TpsTracker(this.processManager, server.name);
      this.tpsTracker.start();
    }

    this.unsubTunnel = this.playitManager.subscribeTunnelLog((chunk) => {
      this.broadcast({ type: 'playit', data: chunk });
    });

    // Surface automatic-backup results to any open dashboard as a toast.
    this.backupScheduler.setListener((result) => this.broadcast({ type: 'notice', data: result }));

    // Realtime: when the server starts/stops (from the dashboard OR the CLI),
    // push a fresh snapshot immediately instead of waiting for the next tick,
    // and re-ask for the player roster on (re)start.
    this.unsubState = this.processManager.onStateChange(() => {
      this.playerTracker?.prime();
      this.tpsTracker?.query();
      this.pushStatus();
    });
    // Tunnel up/down should reflect on the dashboard instantly too.
    this.unsubTunnelStatus = this.playitManager.onStatusChange(() => this.pushStatus());

    this.statusTimer = setInterval(() => {
      // Detect a running→stopped transition every tick (even with no sockets) so
      // the console is cleared, ready for the next start.
      const srv = this.configManager.getServer();
      const running = srv ? !!this.processManager.getActiveServer(srv.name) : false;
      if (this.prevRunning && !running) {
        this.broadcast({ type: 'console-clear' });
      }
      this.prevRunning = running;

      if (this.sockets.size === 0) return; // nothing watching — skip the heavy snapshot
      this.buildOverview().then((ov) => this.broadcast({ type: 'status', data: ov })).catch(() => { /* ignore */ });
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // Static SPA + port binding
  // ---------------------------------------------------------------------------

  private registerStatic(app: FastifyInstance): void {
    const publicDir = path.join(APP_ROOT, 'dist', 'dashboard', 'public');

    if (!fs.existsSync(publicDir)) {
      // Dev convenience: the client hasn't been built yet.
      app.get('/', async (_req, reply) => {
        reply.type('text/html').send(
          '<h1>MCPANEL Dashboard</h1><p>The dashboard client is not built yet. ' +
          'Run <code>npm run build:dashboard</code> and relaunch.</p>',
        );
      });
      logger.warn(`Dashboard client build not found at ${publicDir}.`);
      return;
    }

    app.register(fastifyStatic, { root: publicDir, prefix: '/' });
    // SPA fallback: any non-API, non-asset path serves index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  /** Binds 127.0.0.1, trying successive ports until one is free. */
  private async listenOnFreePort(app: FastifyInstance, start: number): Promise<number> {
    for (let port = start; port < start + 50; port++) {
      try {
        await app.listen({ host: '127.0.0.1', port });
        return port;
      } catch (err: any) {
        if (err?.code !== 'EADDRINUSE') throw err;
      }
    }
    throw new Error('Could not find a free port for the dashboard.');
  }
}
