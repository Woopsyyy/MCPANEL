import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { APP_ROOT } from '../config/configManager';

/**
 * Lightweight "is there a newer version on npm?" checker.
 *
 * - Reads the installed name/version from the package's own package.json.
 * - Asks the npm registry's dist-tags endpoint for the latest version.
 * - Caches the result (logs/.update-check.json) so we only hit the network
 *   every few hours, keeping startup fast.
 * - Fully fail-silent: no network / offline / parse error => returns null.
 */

const CACHE_FILE = path.join(APP_ROOT, 'logs', '.update-check.json');
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-check at most every 6h
const FETCH_TIMEOUT_MS = 2500;

export interface UpdateInfo {
  name: string;
  current: string;
  latest: string;
  updateAvailable: boolean;
}

function readPkg(): { name: string; version: string } | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf-8'));
    if (pkg && pkg.name && pkg.version) return { name: pkg.name, version: pkg.version };
  } catch { /* ignore */ }
  return null;
}

function parseVer(v: string): number[] {
  // Strip any pre-release/build suffix, then split into numeric parts.
  return v.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
}

/** True if `latest` is a higher semver than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVer(latest);
  const b = parseVer(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function fetchLatest(name: string): Promise<string | null> {
  // dist-tags is a tiny payload: {"latest":"1.2.3", ...}
  const url = `https://registry.npmjs.org/-/package/${name.replace('/', '%2F')}/dist-tags`;
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode && res.statusCode >= 400) { res.resume(); resolve(null); return; }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).latest || null); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function readCache(): { latest: string; checkedAt: number } | null {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (c && typeof c.latest === 'string' && typeof c.checkedAt === 'number') return c;
  } catch { /* ignore */ }
  return null;
}

function writeCache(latest: string): void {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ latest, checkedAt: Date.now() }), 'utf-8'); } catch { /* ignore */ }
}

/**
 * Returns update info, or null if it couldn't be determined.
 * Pass force=true (e.g. for an explicit /update command) to bypass the cache.
 */
export async function checkForUpdate(force = false): Promise<UpdateInfo | null> {
  const pkg = readPkg();
  if (!pkg) return null;

  if (!force) {
    const cached = readCache();
    if (cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
      return { name: pkg.name, current: pkg.version, latest: cached.latest, updateAvailable: isNewer(cached.latest, pkg.version) };
    }
  }

  const latest = await fetchLatest(pkg.name);
  if (!latest) return null;
  writeCache(latest);
  return { name: pkg.name, current: pkg.version, latest, updateAvailable: isNewer(latest, pkg.version) };
}
