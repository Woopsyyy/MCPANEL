import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { APP_DATA_DIR } from '../config/configManager';
import { logger } from '../utils/logger';

const DOWNLOADS_DIR = path.join(APP_DATA_DIR, 'downloads');

/**
 * Downloads a file from a URL with redirection support and reports progress.
 */
export function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (downloaded: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mcpanel-agent' } }, (res) => {
      // Handle redirects
      if ([301, 302, 307, 308].includes(res.statusCode || 0)) {
        if (res.headers.location) {
          downloadFile(res.headers.location, destPath, onProgress).then(resolve).catch(reject);
          return;
        }
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Server returned HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      const totalBytes = Number(res.headers['content-length'] || 0);
      const fileStream = fs.createWriteStream(destPath);
      let downloadedBytes = 0;

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        fileStream.write(chunk);
        if (onProgress) {
          onProgress(downloadedBytes, totalBytes);
        }
      });

      res.on('end', () => {
        fileStream.end();
        resolve();
      });

      res.on('error', (err) => {
        fileStream.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Fetches JSON response from a URL (used for API queries)
 */
function fetchJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mcpanel-agent' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode || 0)) {
        if (res.headers.location) {
          fetchJSON(res.headers.location).then(resolve).catch(reject);
          return;
        }
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch JSON: HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

export class DownloadService {
  /**
   * Resolves the download URL for the specified Minecraft software and version.
   */
  public async getDownloadUrl(software: string, version: string): Promise<string> {
    const sw = software.toLowerCase();
    
    if (sw === 'paper' || sw === 'velocity' || sw === 'waterfall') {
      const project = sw;
      const versionUrl = `https://api.papermc.io/v2/projects/${project}/versions/${version}`;
      
      try {
        const versionData = await fetchJSON(versionUrl);
        const builds = versionData.builds;
        if (!builds || builds.length === 0) {
          throw new Error(`No builds found for version ${version}`);
        }
        
        const latestBuild = builds[builds.length - 1];
        const buildUrl = `https://api.papermc.io/v2/projects/${project}/versions/${version}/builds/${latestBuild}`;
        const buildData = await fetchJSON(buildUrl);
        
        const downloadFile = buildData.downloads.application.name;
        return `https://api.papermc.io/v2/projects/${project}/versions/${version}/builds/${latestBuild}/downloads/${downloadFile}`;
      } catch (err: any) {
        logger.error(`Error resolving PaperMC API download URL for ${software} ${version}`, err);
        throw new Error(`Failed to resolve PaperMC download link: ${err.message}`);
      }
    } else if (sw === 'purpur') {
      // Purpur supports a simple redirecting link for the latest build of a version
      return `https://api.purpurmc.org/v2/purpur/${version}/latest/download`;
    }
    
    throw new Error(`Unsupported software type: ${software}`);
  }

  /**
   * Downloads the server jar file if not already cached.
   * Returns the absolute path to the downloaded jar file.
   */
  public async downloadServerJar(
    software: string,
    version: string,
    onProgress?: (pct: number) => void
  ): Promise<string> {
    const sw = software.toLowerCase();
    const jarName = `${sw}-${version}.jar`;
    const cachedPath = path.join(DOWNLOADS_DIR, jarName);

    if (fs.existsSync(cachedPath)) {
      logger.info(`Using cached server jar: ${cachedPath}`);
      if (onProgress) onProgress(100);
      return cachedPath;
    }

    logger.info(`Fetching download URL for ${software} version ${version}...`);
    const downloadUrl = await this.getDownloadUrl(software, version);

    logger.info(`Downloading server jar from: ${downloadUrl}`);
    
    const tempPath = `${cachedPath}.tmp`;
    
    await downloadFile(downloadUrl, tempPath, (downloaded, total) => {
      if (onProgress && total > 0) {
        const pct = parseFloat(((downloaded / total) * 100).toFixed(1));
        onProgress(pct);
      }
    });

    fs.renameSync(tempPath, cachedPath);
    logger.info(`Server jar downloaded and saved to: ${cachedPath}`);
    return cachedPath;
  }
}
