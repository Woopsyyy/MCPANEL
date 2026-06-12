import { ProcessManager } from '../services/processManager';

export interface TpsInfo {
  tps: number | null;   // ticks/sec from the `tps` command, or null if unsupported
  lagging: boolean;     // saw a "can't keep up" warning recently
  supported: boolean;   // whether the server answered a `tps` query
}

/** Removes ANSI + Minecraft section (§x) colour codes before matching. */
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/§./g, '');
}

/**
 * Tracks server ticks-per-second. Periodically issues `tps` (supported by
 * Paper/Purpur/Pufferfish and Carpet on Fabric) and parses the result; also
 * watches for vanilla "Running <ms> behind" overload warnings so we can flag
 * lag even when `tps` isn't available.
 */
export class TpsTracker {
  private tps: number | null = null;
  private supported = false;
  private lastLagAt = 0;
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private processManager: ProcessManager, private serverName: string) {}

  public start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.processManager.subscribeConsole(this.serverName, (data) => this.ingest(data));
    this.timer = setInterval(() => this.query(), 10000);
    setTimeout(() => this.query(), 2500);
  }

  public stop(): void {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.tps = null; this.supported = false; this.lastLagAt = 0;
  }

  public query(): void {
    this.processManager.sendCommand(this.serverName, 'tps');
  }

  public getTps(): TpsInfo {
    return { tps: this.tps, lagging: Date.now() - this.lastLagAt < 30000, supported: this.supported };
  }

  private ingest(chunk: string): void {
    for (const line of strip(chunk).split(/\r?\n/)) {
      // Paper/Purpur: "TPS from last 1m, 5m, 15m: 20.0, 19.9, 20.0"
      const m = line.match(/TPS from last[^:]*:\s*\*?([\d.]+)/i);
      if (m) {
        const v = parseFloat(m[1]);
        if (!isNaN(v)) { this.tps = Math.min(20, v); this.supported = true; }
        continue;
      }
      // Vanilla/Fabric overload warning.
      if (/Can't keep up!|Running \d+ms behind/i.test(line)) {
        this.lastLagAt = Date.now();
      }
    }
  }
}
