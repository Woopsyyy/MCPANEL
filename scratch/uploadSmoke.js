// End-to-end test for Phase 2 content upload + delete. Uses a temp server dir and
// restores the real config.server afterwards so user state is untouched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigManager } = require('../dist/config/configManager');
const { ProcessManager } = require('../dist/services/processManager');
const { ServerManager } = require('../dist/managers/serverManager');
const { BackupManager } = require('../dist/managers/backupManager');
const { PlayitManager } = require('../dist/managers/playitManager');
const { CommandRouter } = require('../dist/commands/commandRouter');
const { DashboardServer } = require('../dist/dashboard/dashboardServer');
const { BackupScheduler } = require('../dist/dashboard/backupScheduler');

(async () => {
  const cfg = new ConfigManager(); cfg.initialize();
  const original = cfg.getServer(); // save to restore later

  // Build a minimal valid server folder (Paper-style → uses plugins/).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-test-'));
  fs.writeFileSync(path.join(tmp, 'server.properties'), 'server-port=25565\n');
  fs.writeFileSync(path.join(tmp, 'paper-1.21.jar'), 'not a real jar');

  const pm = new ProcessManager();
  const sm = new ServerManager(cfg);
  const bm = new BackupManager(cfg);
  const pl = new PlayitManager(cfg);
  const router = new CommandRouter(cfg, pm, sm, bm, pl);
  const sched = new BackupScheduler(cfg, pm, bm);
  const dash = new DashboardServer(cfg, pm, sm, bm, pl, router, sched);

  sm.syncServer(tmp); // sets cfg.server to the temp dir
  const handle = await dash.start();
  const base = `http://127.0.0.1:${handle.port}`;
  const T = handle.token;

  const checks = [];
  try {
    // Upload two files: a valid .jar and a rejected .txt
    const fd = new FormData();
    fd.append('files', new Blob([Buffer.from('jar-bytes')]), 'CoolPlugin.jar');
    fd.append('files', new Blob([Buffer.from('nope')]), 'readme.txt');
    const up = await fetch(`${base}/api/content/upload?token=${T}`, { method: 'POST', body: fd });
    const upBody = await up.json();
    checks.push(['upload accepts .jar', upBody.saved?.includes('CoolPlugin.jar')]);
    checks.push(['upload rejects non-.jar', upBody.rejected?.length === 1]);
    checks.push(['jar written to disk', fs.existsSync(path.join(tmp, 'plugins', 'CoolPlugin.jar'))]);

    // It should now appear in the content listing
    const list = await (await fetch(`${base}/api/content?token=${T}`)).json();
    checks.push(['listing shows upload', list.items.some((i) => i.file === 'CoolPlugin.jar')]);

    // Delete it
    const del = await fetch(`${base}/api/content/CoolPlugin.jar?token=${T}`, { method: 'DELETE' });
    checks.push(['delete ok', del.status === 200]);
    checks.push(['jar removed from disk', !fs.existsSync(path.join(tmp, 'plugins', 'CoolPlugin.jar'))]);

    // Path traversal must be neutralised by basename()
    const trav = await fetch(`${base}/api/content/${encodeURIComponent('../../evil.jar')}?token=${T}`, { method: 'DELETE' });
    checks.push(['traversal delete is safe 404', trav.status === 404]);
  } finally {
    await dash.stop();
    if (original) cfg.setServer(original); // restore real config
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
  process.exitCode = ok ? 0 : 1;
})().catch((e) => { console.error('ERROR', e); process.exitCode = 1; });
