import * as fs from 'fs';
import * as path from 'path';

// Define configuration structures
export interface BackupSettings {
  enabled: boolean;
  intervalHours: number;
  maxBackups: number; // retention: keep only the newest N backups per server
}

export interface PlayitSettings {
  secret?: string;
  tunnelAddress?: string;
  tunnelPort?: number;
  tunnelStatus?: string;
}

export interface ServerMetadata {
  name: string;
  path: string; // Absolute path to the Minecraft server folder
  version: string;
  software: string; // Paper, Fabric, Purpur, Vanilla, etc.
  ram: string;
  displayName?: string; // friendly name shown in the dashboard (folder is never renamed)
  displayIcon?: string; // small data-URL profile picture shown in the dashboard
}

export interface AppConfig {
  defaultJavaPath: string;
  defaultRam: string;
  autoBackupSettings: BackupSettings;
  playitSettings: PlayitSettings;
  // This CLI manages exactly one Minecraft server. `null` until the user
  // syncs a folder path on first launch.
  server: ServerMetadata | null;
  externalBackups: string[];
  backupLocation?: string; // where backups are written (default ~/.mcpanel/backups)
}

import * as os from 'os';

// Dynamically resolve application root folder
export const APP_ROOT = fs.existsSync(path.join(__dirname, '..', '..', 'package.json'))
  ? path.resolve(__dirname, '..', '..')
  : path.resolve(__dirname, '..');

export const APP_DATA_DIR = path.join(os.homedir(), '.mcpanel');

const CONFIG_PATH = path.join(APP_DATA_DIR, 'config.json');

const DEFAULT_CONFIG: AppConfig = {
  defaultJavaPath: 'java',
  defaultRam: '4G',
  autoBackupSettings: {
    enabled: false,
    intervalHours: 24,
    maxBackups: 5,
  },
  playitSettings: {},
  server: null,
  externalBackups: [],
};

export class ConfigManager {
  private config: AppConfig;

  constructor() {
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * Initializes folders and configuration file
   */
  public initialize(): void {
    if (!fs.existsSync(APP_DATA_DIR)) {
      fs.mkdirSync(APP_DATA_DIR, { recursive: true });
    }
    const requiredDirs = ['backups', 'downloads', 'logs', 'playit'];
    for (const dir of requiredDirs) {
      const dirPath = path.join(APP_DATA_DIR, dir);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    }

    this.load();
  }

  /**
   * Loads config.json from disk, falling back to defaults if missing or corrupted
   */
  public load(): void {
    if (!fs.existsSync(CONFIG_PATH)) {
      this.config = { ...DEFAULT_CONFIG, playitSettings: {} };
      this.migrateLegacyConfig();
      this.save();
      return;
    }

    try {
      const fileContent = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(fileContent);

      // Resolve the single managed server. Migrate from the legacy multi-server
      // `servers` map (this CLI used to manage many) by adopting the first entry.
      let server: ServerMetadata | null = null;
      if (parsed.server && typeof parsed.server === 'object') {
        const s = parsed.server;
        server = {
          name: s.name,
          path: s.path,
          version: s.version || 'Unknown',
          software: s.software || 'Vanilla',
          ram: s.ram || parsed.defaultRam || '4G',
          displayName: s.displayName,
          displayIcon: s.displayIcon,
        };
      } else if (parsed.servers && typeof parsed.servers === 'object') {
        const first = Object.values(parsed.servers)[0] as any;
        if (first) {
          server = {
            name: first.name,
            path: first.path,
            version: first.version || 'Unknown',
            software: first.software || 'Vanilla',
            ram: first.ram || parsed.defaultRam || '4G',
            displayName: first.displayName,
          };
        }
      }

      // Ensure key sections are initialized
      const ab = parsed.autoBackupSettings || {};
      this.config = {
        defaultJavaPath: parsed.defaultJavaPath || 'java',
        defaultRam: parsed.defaultRam || '4G',
        autoBackupSettings: {
          enabled: !!ab.enabled,
          intervalHours: ab.intervalHours || 24,
          maxBackups: ab.maxBackups || 5,
        },
        playitSettings: parsed.playitSettings || {},
        server,
        externalBackups: parsed.externalBackups || [],
        backupLocation: parsed.backupLocation || undefined,
      };

      // Recover an already-claimed playit secret from the pre-2.0 config
      // location before persisting (no-op once a secret is present here).
      this.migrateLegacyConfig();

      // Persist the migrated shape so the legacy keys are cleaned up on disk.
      this.save();
    } catch (error) {
      // Config corrupted
      console.warn('⚠️ Config file is corrupted. Rebuilding default config.json...');
      this.config = { ...DEFAULT_CONFIG };
      this.save();
    }
  }

  /**
   * Recovers settings written by versions <2.0, which stored config.json next
   * to the app (`APP_ROOT/config.json`) instead of in `~/.mcpanel`. Without
   * this, an already-claimed playit agent secret is invisible to the new
   * location, so the agent gets re-claimed in the browser on every launch.
   *
   * Only runs when the current config has no playit secret, and never
   * overwrites values already present in the new location.
   */
  private migrateLegacyConfig(): void {
    const legacyPath = path.join(APP_ROOT, 'config.json');
    if (legacyPath === CONFIG_PATH) return;           // same file — nothing to migrate
    if (this.config.playitSettings.secret) return;    // already linked
    if (!fs.existsSync(legacyPath)) return;

    try {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
      if (legacy?.playitSettings?.secret) {
        // Bring the secret + last-known tunnel forward so the existing agent
        // and tunnel are reused instead of re-claimed/recreated.
        this.config.playitSettings = {
          ...legacy.playitSettings,
          ...this.config.playitSettings,
        };
      }
      // Adopt the legacy server only if none is synced in the new location.
      if (!this.config.server && legacy.server && typeof legacy.server === 'object') {
        this.config.server = legacy.server;
      }
    } catch {
      // Unreadable/corrupt legacy config — ignore and continue with defaults.
    }
  }

  /**
   * Saves the current config memory state to disk
   */
  public save(): void {
    try {
      // Defensively recreate the data dir — if it's missing at write time the
      // write throws ENOENT and (previously) the secret was lost silently.
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (error) {
      console.error('❌ Failed to save configuration file:', error);
    }
  }

  /** Absolute path of the config file on disk (for status/diagnostics). */
  public getConfigPath(): string {
    return CONFIG_PATH;
  }

  /**
   * Retrieves the raw config reference
   */
  public getConfig(): AppConfig {
    return this.config;
  }

  /**
   * Updates general settings
   */
  public updateSettings(updates: Partial<AppConfig>): void {
    this.config = { ...this.config, ...updates };
    this.save();
  }

  /**
   * Sets (or replaces) the single managed Minecraft server.
   */
  public setServer(server: ServerMetadata): void {
    this.config.server = server;
    this.save();
  }

  /**
   * Returns the single managed server, or null if none is synced yet.
   */
  public getServer(): ServerMetadata | null {
    return this.config.server;
  }

  /** Absolute directory where backups are written (defaults to ~/.mcpanel/backups). */
  public getBackupLocation(): string {
    return this.config.backupLocation || path.join(APP_DATA_DIR, 'backups');
  }

  /** Sets the backup destination directory and persists it. */
  public setBackupLocation(dir: string): void {
    this.config.backupLocation = path.resolve(dir);
    this.save();
  }

  /**
   * Persists the playit agent secret key so the tunnel only needs claiming once.
   */
  public setPlayitSecret(secret: string): void {
    this.config.playitSettings.secret = secret;
    this.save();
    // The whole point of claiming once is that the secret survives a restart.
    // If it didn't reach disk, fail loudly now instead of silently re-claiming
    // a brand-new agent (and orphaning the old one) on the next launch.
    if (!this.isPlayitSecretPersisted(secret)) {
      throw new Error(
        `Could not persist the playit agent secret to ${CONFIG_PATH}. ` +
        `Check that the folder exists and is writable, then run tunnel again.`
      );
    }
  }

  /** Confirms the agent secret is readable back from disk (not just in memory). */
  private isPlayitSecretPersisted(secret: string): boolean {
    try {
      const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return onDisk?.playitSettings?.secret === secret;
    } catch {
      return false;
    }
  }

  /**
   * Persists the last known tunnel details for status reporting between sessions.
   */
  public updatePlayitTunnel(details: Partial<PlayitSettings>): void {
    this.config.playitSettings = { ...this.config.playitSettings, ...details };
    this.save();
  }

  /**
   * Adds an external backup location
   */
  public addExternalBackup(backupPath: string): boolean {
    const absolute = path.resolve(backupPath);
    if (!this.config.externalBackups.includes(absolute)) {
      this.config.externalBackups.push(absolute);
      this.save();
      return true;
    }
    return false;
  }
}
