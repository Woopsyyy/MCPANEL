import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager, ServerMetadata } from '../config/configManager';
import { normalizeInputPath } from '../utils/helpers';
import { logger } from '../utils/logger';

export class ServerManager {
  private configManager: ConfigManager;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
  }

  /**
   * Helper to ensure server name is safe for directories (alphanumeric, dashes, underscores)
   */
  private cleanServerName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_\-]/g, '');
  }

  /**
   * Inspects a server folder and best-effort detects the server software
   * (Paper, Fabric, Purpur, Vanilla, ...) and the Minecraft version.
   */
  public detectServerInfo(dir: string): { software: string; version: string } {
    let software = 'Vanilla';
    let version = 'Unknown';

    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { return { software, version }; }

    const lowerFiles = files.map(f => f.toLowerCase());
    const jars = lowerFiles.filter(f => f.endsWith('.jar'));
    const jarBlob = jars.join(' ');

    // --- Software detection ---
    const hasFabric =
      lowerFiles.includes('fabric-server-launch.jar') ||
      lowerFiles.includes('fabric-server-launcher.properties') ||
      lowerFiles.includes('.fabric') ||
      lowerFiles.some(f => f.startsWith('fabric-server')) ||
      jarBlob.includes('fabric');

    if (hasFabric) software = 'Fabric';
    else if (jarBlob.includes('purpur')) software = 'Purpur';
    else if (jarBlob.includes('paper')) software = 'Paper';
    else if (jarBlob.includes('spigot')) software = 'Spigot';
    else if (jarBlob.includes('forge') || lowerFiles.some(f => f.includes('forge'))) software = 'Forge';
    else if (jarBlob.includes('velocity')) software = 'Velocity';
    else if (jarBlob.includes('waterfall')) software = 'Waterfall';
    else if (jarBlob.includes('bukkit')) software = 'CraftBukkit';

    // --- Version detection ---
    // 1) Paper/Purpur write a version_history.json with the real MC version.
    const vhPath = path.join(dir, 'version_history.json');
    if (fs.existsSync(vhPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(vhPath, 'utf-8'));
        const cur: string = data.currentVersion || '';
        const m = cur.match(/MC:\s*([\d.]+)/) || cur.match(/(\d+\.\d+(?:\.\d+)?)/);
        if (m) version = m[1];
      } catch { /* ignore */ }
    }

    // 2) Fabric/modern servers store the MC version as a `versions/<ver>` folder.
    if (version === 'Unknown') {
      const versionsDir = path.join(dir, 'versions');
      try {
        const subdirs = fs.readdirSync(versionsDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && /\d+\.\d+/.test(d.name))
          .map(d => d.name);
        if (subdirs.length > 0) version = subdirs[0];
      } catch { /* no versions dir */ }
    }

    // 3) Fall back to a version number embedded in a jar filename.
    if (version === 'Unknown') {
      const m = jarBlob.match(/(\d+\.\d+(?:\.\d+)?)/);
      if (m) version = m[1];
    }

    return { software, version };
  }

  /**
   * Validates and connects an existing Minecraft server directory as THE
   * single server this CLI manages. Persists it to config.
   */
  public syncServer(dirPath: string): ServerMetadata {
    // Translate Windows paths (e.g. C:\...) into WSL mount paths when needed.
    const raw = normalizeInputPath(dirPath);
    const resolvedPath = path.resolve(raw);

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      throw new Error(`Folder "${resolvedPath}" does not exist.`);
    }

    // Verify it looks like a Minecraft server directory.
    const files = fs.readdirSync(resolvedPath);
    const hasProperties = files.includes('server.properties');
    const hasJar = files.some(f => f.toLowerCase().endsWith('.jar'));

    if (!hasProperties && !hasJar) {
      throw new Error('Not a valid Minecraft server folder — no server.properties or .jar file was found.');
    }

    const { software, version } = this.detectServerInfo(resolvedPath);
    const name = this.cleanServerName(path.basename(resolvedPath)) || 'server';

    // Ensure the EULA is accepted so the server won't refuse to launch.
    const eulaPath = path.join(resolvedPath, 'eula.txt');
    if (!fs.existsSync(eulaPath)) {
      try { fs.writeFileSync(eulaPath, 'eula=true\n', 'utf-8'); } catch { /* ignore */ }
    }

    // Preserve a previously chosen RAM allocation if re-syncing the same folder.
    const existing = this.configManager.getServer();
    const ram = existing && path.resolve(existing.path) === resolvedPath
      ? existing.ram
      : this.configManager.getConfig().defaultRam;

    const meta: ServerMetadata = {
      name,
      path: resolvedPath,
      version,
      software,
      ram,
    };

    this.configManager.setServer(meta);
    logger.info(`Synced Minecraft server "${name}" at ${resolvedPath} (${software} ${version})`);

    return meta;
  }

  /**
   * Helper to parse server.properties file.
   */
  public readPropertiesFile(filePath: string): { [key: string]: string } {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const properties: { [key: string]: string } = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) {
        continue;
      }
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();
      properties[key] = value;
    }

    return properties;
  }

  /**
   * Helper to write server.properties file.
   */
  public writePropertiesFile(filePath: string, properties: { [key: string]: string }): void {
    let content = '';
    // If file exists, we want to preserve comments and update keys
    if (fs.existsSync(filePath)) {
      const fileLines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
      const writtenKeys = new Set<string>();

      for (const line of fileLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes('=')) {
          content += line + '\n';
          continue;
        }

        const eqIdx = trimmed.indexOf('=');
        const key = trimmed.substring(0, eqIdx).trim();
        
        if (properties[key] !== undefined) {
          content += `${key}=${properties[key]}\n`;
          writtenKeys.add(key);
        } else {
          content += line + '\n';
        }
      }

      // Append any new properties that were not in the file originally
      for (const [key, value] of Object.entries(properties)) {
        if (!writtenKeys.has(key)) {
          content += `${key}=${value}\n`;
        }
      }
    } else {
      // Just write new properties
      content += '#Minecraft server properties\n';
      for (const [key, value] of Object.entries(properties)) {
        content += `${key}=${value}\n`;
      }
    }

    fs.writeFileSync(filePath, content, 'utf-8');
  }

  /**
   * Updates server.properties of the managed server.
   */
  public updateServerProperties(updates: { [key: string]: string }): void {
    const server = this.configManager.getServer();
    if (!server) {
      throw new Error('No server is connected.');
    }

    const propertiesPath = path.join(server.path, 'server.properties');
    this.writePropertiesFile(propertiesPath, updates);
  }
}
