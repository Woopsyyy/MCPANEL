import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { ConfigManager, APP_ROOT } from '../config/configManager';
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

  /**
   * Creates a zipped backup of the managed server.
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
    const backupDestDir = path.join(APP_ROOT, 'backups');
    
    if (!fs.existsSync(backupDestDir)) {
      fs.mkdirSync(backupDestDir, { recursive: true });
    }

    const backupPath = path.join(backupDestDir, backupFileName);

    logger.info(`Creating backup for server "${server.name}" to ${backupPath}...`);
    
    const zip = new AdmZip();
    zip.addLocalFolder(serverPath);
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

    logger.info(`Backup created successfully: ${backupFileName} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
    return meta;
  }

  /**
   * Lists all available backups in the local backups directory and synced backup locations.
   */
  public listBackups(): BackupMetadata[] {
    const backups: BackupMetadata[] = [];
    const scanDirs = [
      path.join(APP_ROOT, 'backups'),
      ...this.configManager.getConfig().externalBackups
    ];

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
