// Phase 3 tests: settings/ram/playit/maintenance endpoints + save-safe selective
// backups (EBUSY fix), location, retention. Restores real config afterwards.
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { ConfigManager } = require('../dist/config/configManager');
const { ProcessManager } = require('../dist/services/processManager');
const { ServerManager } = require('../dist/managers/serverManager');
const { BackupManager } = require('../dist/managers/backupManager');
const { PlayitManager } = require('../dist/managers/playitManager');
const { CommandRouter } = require('../dist/commands/commandRouter');
const { DashboardServer } = require('../dist/dashboard/dashboardServer');
const { BackupScheduler } = require('../dist/dashboard/backupScheduler');

async function http(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cfg = new ConfigManager(); cfg.initialize();
  const origServer = cfg.getServer();
  const origBackupLoc = cfg.getConfig().backupLocation;
  const origAuto = { ...cfg.getConfig().autoBackupSettings };

  const checks = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-srv-'));
  const backupTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-bk-'));

  // Build a realistic server dir: world + user data + locked-ish file.
  fs.writeFileSync(path.join(tmp, 'server.properties'), 'level-name=world\nserver-port=25565\nmotd=Hi\nmax-players=20\n');
  fs.writeFileSync(path.join(tmp, 'server.jar'), 'jar');
  fs.writeFileSync(path.join(tmp, 'session.lock'), 'LOCK');
  fs.writeFileSync(path.join(tmp, 'ops.json'), '[]');
  fs.mkdirSync(path.join(tmp, 'world'));
  fs.writeFileSync(path.join(tmp, 'world', 'level.dat'), 'world-data');
  fs.mkdirSync(path.join(tmp, 'logs'));
  fs.writeFileSync(path.join(tmp, 'logs', 'latest.log'), 'logs');

  const pm = new ProcessManager();
  const sm = new ServerManager(cfg);
  const bm = new BackupManager(cfg);
  const pl = new PlayitManager(cfg);
  const router = new CommandRouter(cfg, pm, sm, bm, pl);
  const sched = new BackupScheduler(cfg, pm, bm);
  const dash = new DashboardServer(cfg, pm, sm, bm, pl, router, sched);

  sm.syncServer(tmp);
  cfg.setBackupLocation(backupTmp);

  const handle = await dash.start();
  const base = `http://127.0.0.1:${handle.port}`;
  const T = handle.token;

  try {
    // --- API endpoints ---
    const settings = await http(`${base}/api/settings?token=${T}`);
    checks.push(['GET settings ok', settings.status === 200 && settings.body.totalMemGB > 0 && !!settings.body.recommended]);

    const ramBad = await http(`${base}/api/server/ram?token=${T}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gb: 999999 }) });
    checks.push(['RAM rejects > available', ramBad.status === 400]);

    const ramOk = await http(`${base}/api/server/ram?token=${T}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gb: 2 }) });
    checks.push(['RAM accepts valid', ramOk.status === 200 && ramOk.body.ram === '2G']);

    const setPut = await http(`${base}/api/settings?token=${T}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'My SMP', motd: 'Welcome!' }) });
    checks.push(['PUT settings ok', setPut.status === 200 && setPut.body.settings.displayName === 'My SMP']);
    checks.push(['MOTD written to properties', fs.readFileSync(path.join(tmp, 'server.properties'), 'utf-8').includes('motd=Welcome!')]);

    const playit = await http(`${base}/api/playit/status?token=${T}`);
    checks.push(['playit status ok', playit.status === 200 && typeof playit.body.linked === 'boolean']);

    const maint = await http(`${base}/api/maintenance?token=${T}`);
    checks.push(['maintenance ok', maint.status === 200 && maint.body.backupLocation === backupTmp]);

    const playersRes = await http(`${base}/api/players?token=${T}`);
    checks.push(['players endpoint shape', playersRes.status === 200 && Array.isArray(playersRes.body.players)]);

    // Geyser rejects unsupported software (temp server is Vanilla → no Geyser build).
    const geyser = await http(`${base}/api/maintenance/install-geyser?token=${T}`, { method: 'POST' });
    checks.push(['geyser rejects unsupported software', geyser.status === 500 && /no build|Vanilla/i.test(geyser.body.error || '')]);

    // --- Backup: selective, no EBUSY, lands in per-server folder ---
    const made = await http(`${base}/api/backups?token=${T}`, { method: 'POST' });
    checks.push(['backup now succeeds', made.status === 200 && /Backed up|Backup/i.test(made.body.message || '')]);

    const serverBackupDir = path.join(backupTmp, path.basename(tmp).replace(/[^a-zA-Z0-9_\-]/g, ''));
    const zips = fs.existsSync(serverBackupDir) ? fs.readdirSync(serverBackupDir).filter((f) => f.endsWith('.zip')) : [];
    checks.push(['zip in per-server folder', zips.length >= 1]);

    if (zips.length) {
      const entries = new AdmZip(path.join(serverBackupDir, zips[0])).getEntries().map((e) => e.entryName);
      checks.push(['world included', entries.some((e) => e.startsWith('world/'))]);
      checks.push(['ops.json included', entries.includes('ops.json')]);
      checks.push(['session.lock EXCLUDED', !entries.some((e) => e.endsWith('session.lock'))]);
      checks.push(['logs EXCLUDED', !entries.some((e) => e.startsWith('logs/'))]);
    }

    // --- Retention: keep only maxBackups ---
    sched.update(false, 24, 2); // maxBackups = 2
    for (let i = 0; i < 3; i++) { bm.createBackup(); await sleep(5); }
    const remaining = fs.readdirSync(serverBackupDir).filter((f) => f.endsWith('.zip')).length;
    checks.push(['retention prunes to maxBackups', remaining === 2]);
  } finally {
    await dash.stop();
    // Restore real config + clean temp dirs.
    if (origServer) cfg.setServer(origServer);
    cfg.updateSettings({ autoBackupSettings: origAuto, backupLocation: origBackupLoc });
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(backupTmp, { recursive: true, force: true });
  }

  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
  process.exitCode = ok ? 0 : 1;
})().catch((e) => { console.error('ERROR', e); process.exitCode = 1; });
