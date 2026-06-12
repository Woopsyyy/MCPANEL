import { ConfigManager } from '../config/configManager';
import { ProcessManager } from '../services/processManager';
import { BackupManager } from '../managers/backupManager';
import { logger } from '../utils/logger';

export interface ScheduleState {
  enabled: boolean;
  intervalHours: number;
  maxBackups: number;
  nextRunMs: number | null; // epoch ms of the next scheduled run, or null when off
  lastRunMs: number | null;
  lastResult: string | null;
}

/**
 * Runs automatic backups on a configurable interval. When the server is up it
 * performs a Minecraft-safe backup (save-off → save-all flush → zip → save-on) so
 * a *running* world can be backed up without corruption; when offline it backs up
 * directly. Driven by config.autoBackupSettings so it survives restarts, and runs
 * as long as MCPANEL is running — independent of whether the dashboard is open.
 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private nextRunMs: number | null = null;
  private lastRunMs: number | null = null;
  private lastResult: string | null = null;
  private running = false;
  private onRun: ((result: string) => void) | null = null;

  constructor(
    private configManager: ConfigManager,
    private processManager: ProcessManager,
    private backupManager: BackupManager,
  ) {}

  /** Notifies a listener (e.g. the dashboard) whenever an automatic backup runs. */
  public setListener(cb: ((result: string) => void) | null): void {
    this.onRun = cb;
  }

  /** Starts (or restarts) the scheduler from the current config settings. */
  public start(): void {
    this.clear();
    const { enabled, intervalHours } = this.configManager.getConfig().autoBackupSettings;
    if (!enabled) { this.nextRunMs = null; return; }
    const everyMs = Math.max(1, intervalHours) * 3600 * 1000;
    this.nextRunMs = Date.now() + everyMs;
    this.timer = setInterval(() => this.runOnce(), everyMs);
  }

  public stop(): void {
    this.clear();
    this.nextRunMs = null;
  }

  private clear(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  public getState(): ScheduleState {
    const { enabled, intervalHours, maxBackups } = this.configManager.getConfig().autoBackupSettings;
    return { enabled, intervalHours, maxBackups, nextRunMs: this.nextRunMs, lastRunMs: this.lastRunMs, lastResult: this.lastResult };
  }

  /** Persists new settings and reschedules. */
  public update(enabled: boolean, intervalHours: number, maxBackups?: number): ScheduleState {
    const hours = Math.max(1, Math.floor(intervalHours) || 1);
    const current = this.configManager.getConfig().autoBackupSettings;
    const keep = maxBackups != null ? Math.max(1, Math.floor(maxBackups)) : current.maxBackups;
    this.configManager.updateSettings({ autoBackupSettings: { enabled, intervalHours: hours, maxBackups: keep } });
    this.start();
    return this.getState();
  }

  private sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

  /** Performs one save-safe backup now (also used by the scheduled tick). */
  public async runOnce(): Promise<string> {
    if (this.running) return 'A backup is already in progress.';
    const server = this.configManager.getServer();
    if (!server) { this.lastResult = 'Skipped: no server connected.'; return this.lastResult; }

    this.running = true;
    const isUp = !!this.processManager.getActiveServer(server.name);
    try {
      if (isUp) {
        // Freeze world writes so the zip is consistent, then flush to disk.
        this.processManager.sendCommand(server.name, 'save-off');
        this.processManager.sendCommand(server.name, 'save-all flush');
        await this.sleep(3000);
      }
      const meta = this.backupManager.createBackup();
      this.lastResult = `Backed up ${meta.name} (${(meta.sizeBytes / 1024 / 1024).toFixed(1)} MB)${isUp ? ' while running' : ''}.`;
      logger.info(`Automatic backup created: ${meta.name}`);
    } catch (err: any) {
      this.lastResult = `Automatic backup failed: ${err.message}`;
      logger.error('Automatic backup failed', err);
    } finally {
      if (isUp) this.processManager.sendCommand(server.name, 'save-on');
      this.running = false;
      this.lastRunMs = Date.now();
      // Recompute next run relative to this completion when running on a timer.
      const { enabled, intervalHours } = this.configManager.getConfig().autoBackupSettings;
      this.nextRunMs = enabled && this.timer ? Date.now() + Math.max(1, intervalHours) * 3600 * 1000 : this.nextRunMs;
    }
    this.onRun?.(this.lastResult);
    return this.lastResult;
  }
}
