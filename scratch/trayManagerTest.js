// Verifies the tray click handlers: Restart Server stops then starts, Open
// Dashboard delegates to the injected launch flow, and the basic Start/Stop
// branches still route correctly. Runs without a native tray (handleTrayClick
// is exercised directly; updateMenu no-ops when no systray is mounted).
const os = require('os');
const { TrayManager } = require('../dist/managers/trayManager');

const calls = [];

const configManager = {
  getServer: () => ({ name: 'srv', path: os.tmpdir(), ram: '2G' }),
  getConfig: () => ({ defaultJavaPath: 'java' }),
};
const processManager = {
  startServer: async () => { calls.push('start'); },
  stopServer: async () => { calls.push('stop'); },
  getActiveServer: () => undefined,
};
const playitManager = {
  getStatus: () => ({ status: 'Offline' }),
  stopTunnel: () => {},
};

let dashboardOpened = 0;
const onOpenDashboard = async () => { dashboardOpened++; };

const tray = new TrayManager(configManager, processManager, playitManager, onOpenDashboard);

// handleTrayClick is private in TS but callable on the runtime instance.
const click = (title) => tray.handleTrayClick({ item: { title } });

async function run() {
  const checks = [];

  // Menu composition: the new items exist with the expected titles.
  checks.push(['Restart item present', tray.itemServerRestart.title === 'Restart Server']);
  checks.push(['Dashboard item present', tray.itemOpenDashboard.title === 'Open Dashboard']);
  checks.push(['Restart disabled by default (offline)', tray.itemServerRestart.enabled === false]);

  calls.length = 0;
  await click('Start Server');
  checks.push(['Start Server starts', calls.join(',') === 'start']);

  calls.length = 0;
  await click('Stop Server');
  checks.push(['Stop Server stops', calls.join(',') === 'stop']);

  calls.length = 0;
  await click('Restart Server');
  checks.push(['Restart = stop then start, in order', calls.join(',') === 'stop,start']);

  dashboardOpened = 0;
  await click('Open Dashboard');
  checks.push(['Open Dashboard delegates to launch flow', dashboardOpened === 1]);

  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
  process.exitCode = ok ? 0 : 1;
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
