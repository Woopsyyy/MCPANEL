import * as fs from 'fs';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import * as https from 'https';

/**
 * Detects the runtime OS environment: Windows, WSL, or Linux
 */
export function detectOS(): 'Windows' | 'WSL' | 'Linux' {
  if (process.platform === 'win32') {
    return 'Windows';
  }
  
  try {
    if (fs.existsSync('/proc/version')) {
      const versionInfo = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
      if (versionInfo.includes('microsoft') || versionInfo.includes('wsl')) {
        return 'WSL';
      }
    }
  } catch {
    // Ignore error and fall through
  }
  
  return 'Linux';
}

/**
 * Opens a URL in the user's default browser (cross-platform, best-effort).
 * Returns true if a launcher process was spawned, false if none was available.
 */
export function openInBrowser(url: string): boolean {
  const osType = detectOS();
  const candidates: Array<{ cmd: string; args: string[] }> = [];

  if (osType === 'Windows') {
    candidates.push({ cmd: 'cmd', args: ['/c', 'start', '', url] });
  } else if (osType === 'WSL') {
    // Use Windows interop so the link opens in the host's browser.
    candidates.push({ cmd: 'wslview', args: [url] });
    candidates.push({ cmd: 'cmd.exe', args: ['/c', 'start', '', url] });
    candidates.push({ cmd: 'xdg-open', args: [url] });
  } else if (process.platform === 'darwin') {
    candidates.push({ cmd: 'open', args: [url] });
  } else {
    candidates.push({ cmd: 'xdg-open', args: [url] });
  }

  for (const { cmd, args } of candidates) {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      let failed = false;
      child.on('error', () => { failed = true; });
      child.unref();
      if (!failed) return true;
    } catch {
      // Try the next candidate launcher.
    }
  }
  return false;
}

/**
 * Opens a directory in the OS file explorer (cross-platform, best-effort).
 * Returns true if a launcher process was spawned.
 */
export function openInFileExplorer(dir: string): boolean {
  const osType = detectOS();
  const candidates: Array<{ cmd: string; args: string[] }> = [];

  if (osType === 'Windows') {
    candidates.push({ cmd: 'explorer', args: [dir] });
  } else if (osType === 'WSL') {
    // Convert the WSL path to a Windows path and open in Windows Explorer.
    let winPath = '';
    try { winPath = execSync(`wslpath -w "${dir}"`).toString().trim(); } catch { /* ignore */ }
    if (winPath) candidates.push({ cmd: 'explorer.exe', args: [winPath] });
    candidates.push({ cmd: 'xdg-open', args: [dir] });
  } else if (process.platform === 'darwin') {
    candidates.push({ cmd: 'open', args: [dir] });
  } else {
    candidates.push({ cmd: 'xdg-open', args: [dir] });
  }

  for (const { cmd, args } of candidates) {
    try {
      // explorer.exe returns a non-zero exit code even on success, so we don't
      // inspect the exit code — spawning without an immediate throw is enough.
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      let failed = false;
      child.on('error', () => { failed = true; });
      child.unref();
      if (!failed) return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

/**
 * Normalizes a user-supplied folder path so a Windows-style path pasted into a
 * WSL/Linux session (e.g. "C:\Users\me\Server") is converted to its mount path
 * ("/mnt/c/Users/me/Server"). Leaves native paths untouched.
 */
export function normalizeInputPath(input: string): string {
  // Strip surrounding quotes/whitespace.
  const p = input.trim().replace(/^['"]|['"]$/g, '');

  const isWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(p);
  const isUncPath = p.startsWith('\\\\');

  // Only translate Windows paths when we're NOT actually on Windows.
  if ((isWindowsDrivePath || isUncPath) && detectOS() !== 'Windows') {
    // Prefer the real wslpath tool (handles UNC, spaces, casing correctly).
    try {
      const converted = execSync(`wslpath -u '${p.replace(/'/g, "'\\''")}'`)
        .toString()
        .trim();
      if (converted) return converted;
    } catch {
      // wslpath unavailable — fall back to a manual drive-letter conversion.
    }

    const m = p.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (m) {
      const drive = m[1].toLowerCase();
      const rest = m[2].replace(/\\/g, '/');
      return `/mnt/${drive}/${rest}`;
    }
  }

  // Also convert lone backslashes for non-drive inputs on non-Windows hosts.
  if (detectOS() !== 'Windows' && p.includes('\\') && !p.includes('/')) {
    return p.replace(/\\/g, '/');
  }

  return p;
}

/**
 * Opens a NEW terminal window that live-tails a log file (like `tail -f`),
 * so the user can watch server logs while keeping the mcpanel prompt usable.
 * Cross-platform, best-effort. Returns true if a window was launched.
 */
export function openTerminalTail(logPath: string, title: string): boolean {
  const osType = detectOS();
  const candidates: Array<{ cmd: string; args: string[] }> = [];

  if (osType === 'Windows') {
    // PowerShell can follow a growing file; cmd's `start` opens a new window.
    const ps = `Get-Content -Path '${logPath.replace(/'/g, "''")}' -Wait -Tail 200`;
    candidates.push({ cmd: 'cmd', args: ['/c', 'start', title, 'powershell', '-NoExit', '-Command', ps] });
  } else if (osType === 'WSL') {
    // Open a Windows console that runs `wsl tail -f` on the Linux-side path.
    candidates.push({ cmd: 'cmd.exe', args: ['/c', 'start', title, 'wsl.exe', 'tail', '-n', '200', '-f', logPath] });
    // Fall back to a native X terminal if one is available under WSLg.
    candidates.push({ cmd: 'x-terminal-emulator', args: ['-e', `tail -n 200 -f "${logPath}"`] });
    candidates.push({ cmd: 'xterm', args: ['-T', title, '-e', `tail -n 200 -f "${logPath}"`] });
  } else if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script "tail -n 200 -f '${logPath}'"`;
    candidates.push({ cmd: 'osascript', args: ['-e', script] });
  } else {
    candidates.push({ cmd: 'x-terminal-emulator', args: ['-e', `tail -n 200 -f "${logPath}"`] });
    candidates.push({ cmd: 'gnome-terminal', args: ['--title', title, '--', 'bash', '-c', `tail -n 200 -f "${logPath}"; exec bash`] });
    candidates.push({ cmd: 'konsole', args: ['-e', `tail -n 200 -f "${logPath}"`] });
    candidates.push({ cmd: 'xterm', args: ['-T', title, '-e', `tail -n 200 -f "${logPath}"`] });
  }

  for (const { cmd, args } of candidates) {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      let failed = false;
      child.on('error', () => { failed = true; });
      child.unref();
      if (!failed) return true;
    } catch {
      // Try the next candidate terminal.
    }
  }
  return false;
}

/**
 * Recursively sums the byte size of all files under a directory.
 * Symlinks are not followed. Returns 0 on error.
 */
export function getDirSize(dir: string): number {
  let total = 0;
  let stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = `${current}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* ignore */ }
      }
    }
  }
  return total;
}

/**
 * Checks if Java is installed and returns version details
 */
export function checkJava(javaPath = 'java'): { installed: boolean; version: string } {
  try {
    // `java -version` writes to stderr, so merge it into stdout (2>&1) to capture it.
    const result = execSync(`"${javaPath}" -version 2>&1`, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = result.toString() || '';
    return { installed: true, version: cleanJavaVersion(output) };
  } catch (error: any) {
    const stderr = error.stderr ? error.stderr.toString() : '';
    const stdout = error.stdout ? error.stdout.toString() : '';
    const combined = (stderr + '\n' + stdout).trim();
    
    if (combined.includes('version') || combined.includes('openjdk') || combined.includes('Java(TM)')) {
      return { installed: true, version: cleanJavaVersion(combined) };
    }
    
    return { installed: false, version: 'None' };
  }
}

/**
 * Best-effort discovery of installed Java runtimes (Linux/WSL/macOS common
 * locations). Returns each working java binary with its version, newest first.
 */
export function findInstalledJavas(): Array<{ path: string; version: string }> {
  const found = new Map<string, string>(); // path -> version

  const searchRoots = [
    '/usr/lib/jvm',
    '/usr/java',
    '/opt/java',
    '/Library/Java/JavaVirtualMachines',
  ];

  for (const root of searchRoots) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      // Linux layout: <root>/<jdk>/bin/java ; macOS: <jdk>/Contents/Home/bin/java
      const candidates = [
        `${root}/${entry}/bin/java`,
        `${root}/${entry}/Contents/Home/bin/java`,
      ];
      for (const bin of candidates) {
        if (found.has(bin)) continue;
        try {
          if (fs.statSync(bin).isFile()) {
            const info = checkJava(bin);
            if (info.installed) found.set(bin, info.version);
          }
        } catch { /* not a file / not accessible */ }
      }
    }
  }

  return Array.from(found.entries())
    .map(([path, version]) => ({ path, version }))
    // Sort by leading version number descending (newest JDK first).
    .sort((a, b) => parseInt(b.version, 10) - parseInt(a.version, 10));
}

/**
 * Cleans the Java version output to a short recognizable string
 */
function cleanJavaVersion(output: string): string {
  const lines = output.split('\n');
  const versionLine = lines.find(line => line.includes('version') || line.includes('openjdk'));
  if (versionLine) {
    // Extract version (e.g. "17.0.2" or "21.0.1")
    const match = versionLine.match(/"([^"]+)"/);
    if (match && match[1]) {
      return match[1];
    }
    return versionLine.trim();
  }
  return 'Detected';
}

/**
 * Retrieves system resource statistics (CPU and RAM)
 */
export interface SystemStats {
  cpuUsage: number; // Percentage
  totalMemGB: number;
  freeMemGB: number;
  usedMemGB: number;
  memUsagePct: number;
  uptimeSeconds: number;
}

export function getSystemStats(): SystemStats {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  const totalMemGB = parseFloat((totalMem / (1024 * 1024 * 1024)).toFixed(2));
  const freeMemGB = parseFloat((freeMem / (1024 * 1024 * 1024)).toFixed(2));
  const usedMemGB = parseFloat((usedMem / (1024 * 1024 * 1024)).toFixed(2));
  const memUsagePct = parseFloat(((usedMem / totalMem) * 100).toFixed(1));
  
  // Calculate average CPU load percentage from load average over the last 1 min
  const loadAvg = os.loadavg()[0]; // 1-minute load average
  const cpuCount = os.cpus().length;
  // load avg / cpus * 100 capped at 100 or actual representation
  const cpuUsage = parseFloat(Math.min((loadAvg / cpuCount) * 100, 100).toFixed(1));
  
  return {
    cpuUsage: isNaN(cpuUsage) ? 0 : cpuUsage,
    totalMemGB,
    freeMemGB,
    usedMemGB,
    memUsagePct,
    uptimeSeconds: Math.floor(os.uptime()),
  };
}

/**
 * Checks npm registry for a newer version of the CLI package.
 * Returns the latest version string if a newer version is available, or null otherwise.
 */
export function checkForUpdates(currentVersion: string): Promise<string | null> {
  return new Promise((resolve) => {
    const options = {
      hostname: 'registry.npmjs.org',
      path: '/@woopsy/mcpanel/latest',
      method: 'GET',
      timeout: 2000,
      headers: {
        'User-Agent': 'mcpanel-cli',
      },
    };

    const req = https.get(options, (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const latest = parsed.version;
          if (latest && isNewerVersion(currentVersion, latest)) {
            resolve(latest);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Basic semver comparison (a < b)
 */
function isNewerVersion(current: string, latest: string): boolean {
  const cParts = current.split('.').map(Number);
  const lParts = latest.split('.').map(Number);
  
  for (let i = 0; i < 3; i++) {
    const c = cParts[i] || 0;
    const l = lParts[i] || 0;
    if (l > c) return true;
    if (c > l) return false;
  }
  return false;
}
