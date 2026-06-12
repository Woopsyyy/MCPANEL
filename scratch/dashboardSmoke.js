// Isolated smoke test for the dashboard server wiring (no Minecraft server needed).
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
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

(async () => {
  const cfg = new ConfigManager(); cfg.initialize();
  const pm = new ProcessManager();
  const sm = new ServerManager(cfg);
  const bm = new BackupManager(cfg);
  const pl = new PlayitManager(cfg);
  const router = new CommandRouter(cfg, pm, sm, bm, pl);
  const sched = new BackupScheduler(cfg, pm, bm);
  const dash = new DashboardServer(cfg, pm, sm, bm, pl, router, sched);

  const handle = await dash.start();
  const base = `http://127.0.0.1:${handle.port}`;
  console.log('Started at', handle.url);

  const checks = [];
  const noToken = await http(`${base}/api/overview`);
  checks.push(['401 without token', noToken.status === 401]);

  const withToken = await http(`${base}/api/overview?token=${handle.token}`);
  checks.push(['200 with token', withToken.status === 200]);
  checks.push(['overview has system', !!withToken.body && !!withToken.body.system]);

  const spa = await http(`${base}/`);
  checks.push(['SPA index served', spa.status === 200 && String(spa.body).includes('<div id="root">')]);

  const backups = await http(`${base}/api/backups?token=${handle.token}`);
  checks.push(['backups list ok', backups.status === 200 && Array.isArray(backups.body.backups)]);

  // Regression: POST action endpoints must not 400 on an empty JSON body, and
  // should still return a JSON {message}. (`stop` has no side effects here.)
  const postEmpty = await http(`${base}/api/server/stop?token=${handle.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  });
  checks.push(['POST empty-body not 400', postEmpty.status === 200 && typeof postEmpty.body.message === 'string']);

  const postNoToken = await http(`${base}/api/server/stop`, { method: 'POST' });
  checks.push(['POST rejected without token', postNoToken.status === 401]);

  // Phase 2: backup schedule get/put.
  const sched1 = await http(`${base}/api/backups/schedule?token=${handle.token}`);
  checks.push(['schedule get ok', sched1.status === 200 && typeof sched1.body.enabled === 'boolean']);
  const sched2 = await http(`${base}/api/backups/schedule?token=${handle.token}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false, intervalHours: 12 }),
  });
  checks.push(['schedule put ok', sched2.status === 200 && sched2.body.intervalHours === 12]);

  // WebSocket: a valid token must receive a 'status' snapshot on connect.
  const wsBase = `ws://127.0.0.1:${handle.port}/ws`;
  const gotStatus = await new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}?token=${handle.token}`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 3000);
    ws.onmessage = (ev) => {
      try { const m = JSON.parse(ev.data); if (m.type === 'status') { clearTimeout(timer); ws.close(); resolve(true); } } catch {}
    };
    ws.onerror = () => { clearTimeout(timer); resolve(false); };
  });
  checks.push(['WS status snapshot with token', gotStatus]);

  // WebSocket: an invalid token must be rejected (closed, no status delivered).
  const rejected = await new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}?token=wrong`);
    let got = false;
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(!got); }, 1500);
    ws.onmessage = () => { got = true; };
    ws.onclose = () => { clearTimeout(timer); resolve(!got); };
    ws.onerror = () => { clearTimeout(timer); resolve(!got); };
  });
  checks.push(['WS rejected without valid token', rejected]);

  await dash.stop();

  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
  process.exitCode = ok ? 0 : 1; // let handles close naturally — no forced exit
})().catch((e) => { console.error('ERROR', e); process.exitCode = 1; });
