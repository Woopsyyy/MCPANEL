import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { ConfigManager, APP_DATA_DIR } from '../config/configManager';
import { logger } from '../utils/logger';

export interface BackupMetadata {
  id: string;
  name: string; // Filename
  serverName: string;
  sizeBytes: number;
  createdAt: string;
  path: string;
}

export class BackupManager {
  private configManager: ConfigManager;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
  }

  // Files/folders that are either regenerable or held open by a running JVM.
  // Backing these up causes the EBUSY "resource busy or locked" crash, so we
  // never include them — a backup is the world + user data needed to roll back.
  private static readonly SKIP_NAMES = new Set(['session.lock']);

  /**
   * Creates a backup of the world(s) + user data only. Each file is read
   * individually and any locked/unreadable file (e.g. while the server runs) is
   * skipped rather than aborting the whole backup. Written into a per-server
   * folder under the configured backup location, then pruned to the retention
   * limit.
   */
  public createBackup(): BackupMetadata {
    const server = this.configManager.getServer();
    if (!server) {
      throw new Error('No server is connected.');
    }

    const serverPath = path.resolve(server.path);
    if (!fs.existsSync(serverPath)) {
      throw new Error(`Server path "${serverPath}" does not exist.`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `${server.name}_backup_${timestamp}.zip`;
    const backupDestDir = path.join(this.configManager.getBackupLocation(), server.name);
    if (!fs.existsSync(backupDestDir)) {
      fs.mkdirSync(backupDestDir, { recursive: true });
    }
    const backupPath = path.join(backupDestDir, backupFileName);

    logger.info(`Creating backup for server "${server.name}" to ${backupPath}...`);

    const zip = new AdmZip();
    let added = 0;
    let skipped = 0;
    for (const rel of this.collectBackupTargets(serverPath)) {
      const result = this.addPathToZip(zip, serverPath, path.join(serverPath, rel));
      added += result.added;
      skipped += result.skipped;
    }

    if (added === 0) {
      throw new Error('Nothing to back up — no world or user-data files were found in the server folder.');
    }

    zip.writeZip(backupPath);
    const stats = fs.statSync(backupPath);

    const meta: BackupMetadata = {
      id: `${server.name}_${timestamp}`,
      name: backupFileName,
      serverName: server.name,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
      path: backupPath,
    };

    logger.info(`Backup created: ${backupFileName} (${(stats.size / (1024 * 1024)).toFixed(2)} MB, ${added} files, ${skipped} skipped)`);
    this.pruneBackups(backupDestDir, this.configManager.getConfig().autoBackupSettings.maxBackups);
    return meta;
  }

  /** Reads `level-name` from server.properties (defaults to "world"). */
  private getLevelName(serverPath: string): string {
    try {
      const txt = fs.readFileSync(path.join(serverPath, 'server.properties'), 'utf-8');
      const m = txt.match(/^\s*level-name\s*=\s*(.+?)\s*$/m);
      if (m && m[1]) return m[1];
    } catch { /* default */ }
    return 'world';
  }

  /** Top-level entries (relative) to include: the world dims + user-data files. */
  private collectBackupTargets(serverPath: string): string[] {
    const level = this.getLevelName(serverPath);
    const candidates = [
      level, `${level}_nether`, `${level}_the_end`,
      'world', 'world_nether', 'world_the_end',
      'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json',
      'usercache.json', 'server.properties',
    ];
    const seen = new Set<string>();
    return candidates.filter((c) => {
      if (seen.has(c)) return false;
      seen.add(c);
      return fs.existsSync(path.join(serverPath, c));
    });
  }

  /** Recursively adds a file or folder to the zip, skipping locked/unreadable files. */
  private addPathToZip(zip: AdmZip, root: string, abs: string): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { return { added, skipped: skipped + 1 }; }

    if (stat.isDirectory()) {
      let entries: string[] = [];
      try { entries = fs.readdirSync(abs); } catch { return { added, skipped: skipped + 1 }; }
      for (const name of entries) {
        const r = this.addPathToZip(zip, root, path.join(abs, name));
        added += r.added; skipped += r.skipped;
      }
      return { added, skipped };
    }

    if (BackupManager.SKIP_NAMES.has(path.basename(abs))) return { added, skipped };
    try {
      const buf = fs.readFileSync(abs);
      const entryName = path.relative(root, abs).split(path.sep).join('/');
      zip.addFile(entryName, buf);
      added++;
    } catch (err: any) {
      // EBUSY / EACCES / locked file while the server runs — skip it, keep going.
      logger.warn(`Skipping locked/unreadable file in backup: ${abs} (${err.code || err.message})`);
      skipped++;
    }
    return { added, skipped };
  }

  /** Keeps only the newest `max` .zip backups in a folder, deleting the rest. */
  private pruneBackups(dir: string, max: number): void {
    if (!max || max < 1) return;
    let files: { p: string; mtime: number }[] = [];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.zip'))
        .map((f) => ({ p: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch { return; }
    for (const f of files.slice(max)) {
      try { fs.unlinkSync(f.p); logger.info(`Pruned old backup: ${path.basename(f.p)}`); }
      catch (err) { logger.error(`Failed to prune backup ${f.p}`, err); }
    }
  }

  /**
   * Lists all available backups in the local backups directory and synced backup locations.
   */
  public listBackups(): BackupMetadata[] {
    const backups: BackupMetadata[] = [];
    const location = this.configManager.getBackupLocation();

    // Scan the backup location, each of its per-server subfolders, the legacy
    // flat ~/.mcpanel/backups dir, and any external backup folders.
    const dirSet = new Set<string>([location, path.join(APP_DATA_DIR, 'backups'), ...this.configManager.getConfig().externalBackups]);
    try {
      for (const entry of fs.readdirSync(location, { withFileTypes: true })) {
        if (entry.isDirectory()) dirSet.add(path.join(location, entry.name));
      }
    } catch { /* location may not exist yet */ }
    const scanDirs = Array.from(dirSet);

    for (const dir of scanDirs) {
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.zip')) continue;

        const filePath = path.join(dir, file);
        try {
          const stats = fs.statSync(filePath);
          
          // Parse server name and timestamp from filename: ServerName_backup_YYYY-MM-DD...
          let serverName = 'Unknown';
          if (file.includes('_backup_')) {
            serverName = file.split('_backup_')[0];
          }

          // Use file stats for timestamp if we can't extract it easily
          const createdAt = stats.mtime.toISOString();
          const id = file.replace('.zip', '');

          backups.push({
            id,
            name: file,
            serverName,
            sizeBytes: stats.size,
            createdAt,
            path: filePath,
          });
        } catch (err) {
          // Ignore issues reading single file stats
        }
      }
    }

    // Sort backups by creation time descending (newest first)
    return backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Synchronizes an external backup directory.
   */
  public syncBackup(dirPath: string): number {
    const resolvedPath = path.resolve(dirPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Backup directory "${resolvedPath}" does not exist.`);
    }

    this.configManager.addExternalBackup(resolvedPath);
    
    // Count .zip files found
    const files = fs.readdirSync(resolvedPath);
    const backupZips = files.filter(f => f.endsWith('.zip'));

    logger.info(`Synchronized backup source: ${resolvedPath} (${backupZips.length} backups found)`);
    return backupZips.length;
  }

  /**
   * Restores a backup safely, unzipping contents and avoiding directory traversal.
   */
  public restoreBackup(backupId: string): void {
    const server = this.configManager.getServer();
    if (!server) {
      throw new Error('No server is connected.');
    }

    const backups = this.listBackups();
    const backup = backups.find(b => b.id === backupId || b.name === backupId);
    if (!backup) {
      throw new Error(`Backup "${backupId}" was not found.`);
    }

    const serverDir = path.resolve(server.path);
    const zipPath = path.resolve(backup.path);

    logger.warn(`Restoring backup "${backup.name}" to server "${server.name}" at ${serverDir}`);

    if (!fs.existsSync(zipPath)) {
      throw new Error(`Backup file "${zipPath}" no longer exists on disk.`);
    }

    // --- SECURE ZIP EXTRACTION (Zip Slip Prevention) ---
    const zip = new AdmZip(zipPath);
    
    for (const entry of zip.getEntries()) {
      // Resolve target path of this entry
      const entryName = entry.entryName;
      const targetPath = path.resolve(serverDir, entryName);

      // Verify directory boundary (prevent directory traversal)
      if (!targetPath.startsWith(serverDir + path.sep) && targetPath !== serverDir) {
        logger.error(`[SECURITY] Blocked potential Zip Slip: entry "${entryName}" resolves to "${targetPath}" which is outside "${serverDir}"`);
        throw new Error('Restoration aborted: Corrupted or malicious zip archive containing path traversal entries was detected.');
      }
    }

    // Cleanup server directory first to remove current state files
    logger.info(`Clearing server directory "${serverDir}" before restoration...`);
    this.clearDirectoryContent(serverDir);

    // Extract files safely
    logger.info(`Extracting backup archive contents to "${serverDir}"...`);
    zip.extractAllTo(serverDir, true);
    logger.info(`Server "${server.name}" has been successfully restored from backup "${backup.name}"`);
  }

  /**
   * Helper to clean directory contents without removing the directory itself.
   */
  private clearDirectoryContent(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        logger.error(`Failed to delete "${filePath}" during directory cleanup`, err);
      }
    }
  }
}
