import * as fs from 'fs';
import * as path from 'path';

// Define configuration structures
export interface BackupSettings {
  enabled: boolean;
  intervalHours: number;
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
}

// Dynamically resolve application root folder
export const APP_ROOT = fs.existsSync(path.join(__dirname, '..', '..', 'package.json'))
  ? path.resolve(__dirname, '..', '..')
  : path.resolve(__dirname, '..');

const CONFIG_PATH = path.join(APP_ROOT, 'config.json');

const DEFAULT_CONFIG: AppConfig = {
  defaultJavaPath: 'java',
  defaultRam: '4G',
  autoBackupSettings: {
    enabled: false,
    intervalHours: 24,
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
    const requiredDirs = ['backups', 'downloads', 'logs', 'playit'];
    for (const dir of requiredDirs) {
      const dirPath = path.join(APP_ROOT, dir);
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
      this.config = { ...DEFAULT_CONFIG };
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
          };
        }
      }

      // Ensure key sections are initialized
      this.config = {
        defaultJavaPath: parsed.defaultJavaPath || 'java',
        defaultRam: parsed.defaultRam || '4G',
        autoBackupSettings: parsed.autoBackupSettings || { enabled: false, intervalHours: 24 },
        playitSettings: parsed.playitSettings || {},
        server,
        externalBackups: parsed.externalBackups || [],
      };

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
   * Saves the current config memory state to disk
   */
  public save(): void {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (error) {
      console.error('❌ Failed to save configuration file:', error);
    }
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

  /**
   * Persists the playit agent secret key so the tunnel only needs claiming once.
   */
  public setPlayitSecret(secret: string): void {
    this.config.playitSettings.secret = secret;
    this.save();
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
