import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import { spawn, ChildProcess, execFile } from 'child_process';
import { ConfigManager, APP_ROOT } from '../config/configManager';
import { detectOS } from '../utils/helpers';
import { downloadFile } from '../services/downloadService';
import { logger } from '../utils/logger';

export interface TunnelStatus {
  address: string;
  port: string;
  status: 'Offline' | 'Connecting' | 'Online';
  latency: string;
  type: 'java' | 'bedrock' | null;
  claimUrl: string | null;
}

/** Callbacks used to surface progress of the (one-time) automated setup flow to the UI. */
export interface SetupCallbacks {
  onClaimUrl?: (url: string) => void;
  onStatus?: (message: string) => void;
}

// playit agent version this manager targets. Bump to force a re-download.
const PLAYIT_VERSION = '1.0.8';
const PLAYIT_API = 'https://api.playit.gg';

/** Strips ANSI colour / cursor escape sequences that the playit binaries emit. */
function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[78]/g, '')
    .replace(/\x1b[()][AB012]/g, '');
}

export class PlayitManager {
  private configManager: ConfigManager;
  private playitProcess: ChildProcess | null = null;
  private claimProcess: ChildProcess | null = null;
  private tunnelStatus: TunnelStatus;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
    this.tunnelStatus = this.offlineStatus();
  }

  private offlineStatus(): TunnelStatus {
    return {
      address: 'None',
      port: 'None',
      status: 'Offline',
      latency: 'N/A',
      type: null,
      claimUrl: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Binary management (v1.0.8: split into the agent daemon + the control cli)
  // ---------------------------------------------------------------------------

  /** Path to the agent/daemon binary (used as the traffic relay). */
  public getExecutablePath(): string {
    const osType = detectOS();
    const binName = osType === 'Windows' ? 'playit.exe' : 'playit';
    return path.join(APP_ROOT, 'playit', binName);
  }

  /** Path to the control cli (used for the one-time claim flow). */
  public getCliPath(): string {
    const osType = detectOS();
    // v1.0.8 only ships a separate cli for Linux; on Windows the main exe is used.
    if (osType === 'Windows') return this.getExecutablePath();
    return path.join(APP_ROOT, 'playit', 'playit-cli');
  }

  /** IPC socket / named pipe the daemon binds to (its default location may not exist). */
  private getSocketPath(): string {
    const osType = detectOS();
    if (osType === 'Windows') return '\\\\.\\pipe\\mcpanel-playit';
    return path.join(APP_ROOT, 'playit', 'agent.sock');
  }

  private getVersionSentinel(): string {
    return path.join(APP_ROOT, 'playit', '.version');
  }

  private downloadUrls(): { agent: string; cli: string | null } {
    const base = `https://github.com/playit-cloud/playit-agent/releases/download/v${PLAYIT_VERSION}`;
    if (detectOS() === 'Windows') {
      return { agent: `${base}/playit-windows-x86_64.exe`, cli: null };
    }
    return { agent: `${base}/playit-linux-amd64`, cli: `${base}/playit-cli-linux-amd64` };
  }

  /** True when both required binaries exist AND match the targeted version. */
  public isBinaryPresent(): boolean {
    if (!fs.existsSync(this.getExecutablePath())) return false;
    const cli = this.getCliPath();
    if (cli !== this.getExecutablePath() && !fs.existsSync(cli)) return false;
    try {
      return fs.readFileSync(this.getVersionSentinel(), 'utf-8').trim() === PLAYIT_VERSION;
    } catch {
      return false;
    }
  }

  /** Downloads (or upgrades) the playit agent + cli for the detected platform. */
  public async downloadBinary(onProgress?: (pct: number) => void): Promise<string> {
    const osType = detectOS();
    const binPath = this.getExecutablePath();
    const playitDir = path.dirname(binPath);
    const urls = this.downloadUrls();

    if (!fs.existsSync(playitDir)) {
      fs.mkdirSync(playitDir, { recursive: true });
    }

    const fetchTo = async (url: string, dest: string) => {
      const tmp = `${dest}.tmp`;
      await downloadFile(url, tmp, (downloaded, total) => {
        if (onProgress && total > 0) onProgress(Math.round((downloaded / total) * 100));
      });
      fs.renameSync(tmp, dest);
      if (osType !== 'Windows') {
        try { fs.chmodSync(dest, 0o755); } catch (err) { logger.error('chmod failed', err); }
      }
    };

    logger.info(`Downloading playit agent v${PLAYIT_VERSION} for ${osType}...`);
    await fetchTo(urls.agent, binPath);
    if (urls.cli) {
      logger.info('Downloading playit control cli...');
      await fetchTo(urls.cli, this.getCliPath());
    }

    fs.writeFileSync(this.getVersionSentinel(), PLAYIT_VERSION, 'utf-8');
    logger.info(`Playit binaries ready (v${PLAYIT_VERSION}).`);
    return binPath;
  }

  private async ensureBinary(): Promise<void> {
    if (!this.isBinaryPresent()) {
      logger.info('Playit binary missing or outdated. Downloading...');
      await this.downloadBinary();
    }
  }

  public getSecret(): string | null {
    return this.configManager.getConfig().playitSettings.secret || null;
  }

  // ---------------------------------------------------------------------------
  // playit HTTP API (authenticated with the agent secret)
  // ---------------------------------------------------------------------------

  private apiPost(apiPath: string, body: any, secret: string): Promise<any> {
    const payload = JSON.stringify(body || {});
    const url = new URL(PLAYIT_API + apiPath);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Authorization': `agent-key ${secret}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            let parsed: any;
            try { parsed = JSON.parse(data); } catch { reject(new Error(`Bad API response: ${data.slice(0, 200)}`)); return; }
            if (parsed.status === 'success') {
              resolve(parsed.data);
            } else {
              const detail = typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data);
              reject(new Error(`playit API ${apiPath} failed: ${detail}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /** Returns agent run data: { agent_id, tunnels[], pending[] }. */
  private getRunData(secret: string): Promise<any> {
    return this.apiPost('/agents/rundata', {}, secret);
  }

  /**
   * Unauthenticated POST for the claim endpoints. Unlike apiPost it returns the
   * raw { status, data } envelope and does NOT throw on `status:"fail"` — a fail
   * (e.g. "CodeNotFound" while waiting for approval) is a normal polling state.
   */
  private apiClaim(apiPath: string, body: any): Promise<{ status: string; data: any }> {
    const payload = JSON.stringify(body || {});
    const url = new URL(PLAYIT_API + apiPath);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve({ status: parsed.status, data: parsed.data });
            } catch {
              reject(new Error(`Bad claim response: ${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /** Picks the public address from a rundata tunnel entry. */
  private tunnelAddress(tunnel: any): { address: string; port: string } {
    const port = tunnel?.port?.from ?? tunnel?.local_port ?? 0;
    return { address: tunnel.assigned_domain, port: String(port) };
  }

  /** Finds an existing tunnel matching the requested protocol. */
  private findTunnel(rd: any, type: 'java' | 'bedrock'): any | null {
    const proto = type === 'java' ? 'tcp' : 'udp';
    const tunnels = (rd?.tunnels || []) as any[];
    return tunnels.find((t) => t.proto === proto) || null;
  }

  /** Creates a new tunnel via the API (replaces the broken `tunnels prepare` CLI). */
  private async createApiTunnel(type: 'java' | 'bedrock', agentId: string, secret: string): Promise<void> {
    const body = {
      name: type === 'java' ? 'Minecraft Java' : 'Minecraft Bedrock',
      tunnel_type: type === 'java' ? 'minecraft-java' : 'minecraft-bedrock',
      port_type: type === 'java' ? 'tcp' : 'udp',
      port_count: 1,
      origin: {
        type: 'agent',
        data: {
          agent_id: agentId,
          local_ip: '127.0.0.1',
          local_port: type === 'java' ? 25565 : 19132,
        },
      },
      enabled: true,
      alloc: null,
      firewall_id: null,
      proxy_protocol: null,
    };
    await this.apiPost('/tunnels/create', body, secret);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------------------------------------------------------------------------
  // One-time claim flow (uses the control cli; persists the secret)
  // ---------------------------------------------------------------------------

  private runCli(args: string[], timeoutMs = 30000): Promise<string> {
    const cliPath = this.getCliPath();
    return new Promise((resolve, reject) => {
      execFile(cliPath, args, { cwd: path.dirname(cliPath), timeout: timeoutMs }, (error, stdout, stderr) => {
        const out = stripAnsi(stdout || '').trim();
        const err = stripAnsi(stderr || '').trim();
        if (error) { reject(new Error(err || out || error.message)); return; }
        resolve(out);
      });
    });
  }

  /**
   * Ensures a write-capable agent secret, driving the one-time claim if needed.
   *
   * The claim is done entirely over the playit HTTP API (no playit-cli), so it
   * works identically on Windows, WSL, Linux and macOS. The agent binary is only
   * needed later, for the traffic relay.
   */
  public async ensureSecret(callbacks: SetupCallbacks = {}): Promise<string> {
    const existing = this.getSecret();
    if (existing) return existing;

    // A claim code is just a short random hex string generated client-side.
    const code = crypto.randomBytes(5).toString('hex');
    const claimBody = { code, agent_type: 'self-managed', version: 'mcpanel 1.0' };

    callbacks.onStatus?.('Generating a new agent claim code...');
    await this.apiClaim('/claim/setup', claimBody);

    const url = `https://playit.gg/claim/${code}`;
    this.tunnelStatus.claimUrl = url;
    callbacks.onClaimUrl?.(url);

    // Poll setup (which also keeps the code alive) until the user approves.
    callbacks.onStatus?.('Waiting for you to approve the agent in your browser (this only happens once)...');
    const deadline = Date.now() + 5 * 60 * 1000; // 5 minutes
    let approved = false;
    while (Date.now() < deadline) {
      await this.sleep(3000);
      const res = await this.apiClaim('/claim/setup', claimBody);
      const status = typeof res.data === 'string' ? res.data : '';
      if (status === 'UserAccepted') { approved = true; break; }
      if (status === 'UserRejected') {
        this.tunnelStatus.claimUrl = null;
        throw new Error('Claim was rejected in the browser. Run /setup to try again.');
      }
    }
    if (!approved) {
      this.tunnelStatus.claimUrl = null;
      throw new Error('Timed out waiting for approval. Open the link, click Approve, then run /setup again.');
    }

    // Exchange the approved code for the 64-char agent secret.
    callbacks.onStatus?.('Approved! Retrieving your agent secret...');
    let secret = '';
    for (let i = 0; i < 10 && !secret; i++) {
      const ex = await this.apiClaim('/claim/exchange', { code });
      const match = JSON.stringify(ex.data ?? '').match(/[a-f0-9]{64}/i);
      if (ex.status === 'success' && match) secret = match[0].toLowerCase();
      else await this.sleep(2000);
    }
    if (!secret) {
      this.tunnelStatus.claimUrl = null;
      throw new Error('Could not retrieve the agent secret after approval. Run /setup to try again.');
    }

    this.configManager.setPlayitSecret(secret);
    this.tunnelStatus.claimUrl = null;
    callbacks.onStatus?.('Agent claimed and linked. Secret saved — future tunnels are fully automatic.');
    return secret;
  }

  // ---------------------------------------------------------------------------
  // Full automated setup
  // ---------------------------------------------------------------------------

  /**
   * One-call entry point: ensures binary + secret, creates the tunnel via the
   * API, starts the relay daemon, and returns the live tunnel status.
   */
  public async setupAndStart(type: 'java' | 'bedrock', callbacks: SetupCallbacks = {}): Promise<TunnelStatus> {
    await this.ensureBinary();
    const secret = await this.ensureSecret(callbacks);

    this.tunnelStatus.status = 'Connecting';
    this.tunnelStatus.type = type;

    callbacks.onStatus?.('Checking your playit account for an existing tunnel...');
    let rd = await this.getRunData(secret);
    let tunnel = this.findTunnel(rd, type);

    if (!tunnel) {
      callbacks.onStatus?.(`Creating ${type} tunnel...`);
      await this.createApiTunnel(type, rd.agent_id, secret);

      // Poll until the tunnel leaves "pending" and gets a public address.
      for (let i = 0; i < 15 && !tunnel; i++) {
        await this.sleep(3000);
        rd = await this.getRunData(secret);
        tunnel = this.findTunnel(rd, type);
      }
      if (!tunnel) {
        throw new Error('Tunnel was created but no public address appeared yet. Try /tunnel status shortly.');
      }
    }

    const { address, port } = this.tunnelAddress(tunnel);
    this.tunnelStatus.address = address;
    this.tunnelStatus.port = port;
    this.configManager.updatePlayitTunnel({ tunnelAddress: address, tunnelPort: Number(port) });

    callbacks.onStatus?.('Starting tunnel relay...');
    await this.startAgent(secret);

    this.tunnelStatus.status = 'Online';
    return this.tunnelStatus;
  }

  /** Spawns the long-running daemon that relays tunnel traffic. */
  private startAgent(secret: string): Promise<void> {
    return new Promise((resolve) => {
      if (this.playitProcess) { resolve(); return; }

      const binPath = this.getExecutablePath();
      const socketPath = this.getSocketPath();
      // Clear any stale unix socket so the daemon can bind.
      if (detectOS() !== 'Windows') {
        try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch { /* ignore */ }
      }

      logger.logTunnel('Starting playit relay daemon...');
      this.playitProcess = spawn(binPath, ['--secret', secret, '--socket-path', socketPath], {
        cwd: path.dirname(binPath),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.playitProcess.stdout?.on('data', (d: Buffer) => {
        const chunk = stripAnsi(d.toString());
        logger.logTunnel(`[stdout] ${chunk.trim()}`);
        this.parsePlayitOutput(chunk);
      });
      this.playitProcess.stderr?.on('data', (d: Buffer) => {
        const chunk = stripAnsi(d.toString());
        logger.logTunnel(`[stderr] ${chunk.trim()}`);
        this.parsePlayitOutput(chunk);
      });
      this.playitProcess.on('close', (code) => {
        logger.logTunnel(`Playit relay exited with code ${code}`);
        this.playitProcess = null;
        this.tunnelStatus = this.offlineStatus();
      });
      this.playitProcess.on('error', (err) => {
        logger.error('Playit relay process error', err);
        this.tunnelStatus.status = 'Offline';
      });

      // Give the daemon a moment to register, then continue.
      setTimeout(resolve, 2000);
    });
  }

  public stopTunnel(): boolean {
    let stopped = false;
    if (this.claimProcess) {
      try { this.claimProcess.kill('SIGINT'); } catch { /* ignore */ }
      this.claimProcess = null;
      stopped = true;
    }
    if (this.playitProcess) {
      logger.logTunnel('Stopping playit relay daemon...');
      try { this.playitProcess.kill('SIGINT'); } catch (err) { logger.error('Failed to stop relay', err); }
      this.playitProcess = null;
      stopped = true;
    }
    this.tunnelStatus = this.offlineStatus();
    return stopped;
  }

  public getStatus(): TunnelStatus {
    return this.tunnelStatus;
  }

  /** Clears the saved secret so the agent can be re-claimed from scratch. */
  public async resetSecret(): Promise<void> {
    this.stopTunnel();
    this.configManager.updatePlayitTunnel({ secret: undefined });
    try { await this.runCli(['reset']); } catch { /* local secret already cleared */ }
  }

  /** Parses relay logs to keep latency/status fresh. */
  private parsePlayitOutput(output: string): void {
    if (/agent registered|udp session details|tunnel running|tunnel active/i.test(output)) {
      this.tunnelStatus.status = 'Online';
    }
    const pingMatch = output.match(/ping:\s*(\d+\.?\d*ms)/i) || output.match(/latency:\s*(\d+\.?\d*ms)/i);
    if (pingMatch) this.tunnelStatus.latency = pingMatch[1];
  }
}
