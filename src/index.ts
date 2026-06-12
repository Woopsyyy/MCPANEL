#!/usr/bin/env node

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import figlet from 'figlet';
import { ConfigManager, APP_ROOT, APP_DATA_DIR } from './config/configManager';
import { ProcessManager } from './services/processManager';
import { ServerManager } from './managers/serverManager';
import { BackupManager } from './managers/backupManager';
import { PlayitManager } from './managers/playitManager';
import { CommandRouter } from './commands/commandRouter';
import { DashboardServer } from './dashboard/dashboardServer';
import { BackupScheduler } from './dashboard/backupScheduler';
import * as colors from './utils/colors';
import { detectOS, checkJava, findInstalledJavas, installTemurin25, openInBrowser } from './utils/helpers';
import { checkForUpdate } from './services/updateChecker';
import { logger } from './utils/logger';
import { TrayManager } from './managers/trayManager';

// Initialize managers
const configManager = new ConfigManager();
configManager.initialize();

const processManager = new ProcessManager();
const serverManager = new ServerManager(configManager);
const backupManager = new BackupManager(configManager);
const playitManager = new PlayitManager(configManager);
const trayManager = new TrayManager(configManager, processManager, playitManager);

const router = new CommandRouter(
  configManager,
  processManager,
  serverManager,
  backupManager,
  playitManager
);

const backupScheduler = new BackupScheduler(configManager, processManager, backupManager);

const dashboardServer = new DashboardServer(
  configManager,
  processManager,
  serverManager,
  backupManager,
  playitManager,
  router,
  backupScheduler
);

const HISTORY_PATH = path.join(APP_DATA_DIR, 'logs', '.history');

// State machine states
type ShellState =
  | 'COMMAND'
  | 'WIZARD_SYNC_PATH'
  | 'WIZARD_TUNNEL_TYPE'
  | 'PROPERTIES_SELECT'
  | 'PROPERTIES_INPUT'
  | 'CONSOLE'
  | 'LOG_VIEW'
  | 'TUNNEL_LOG_VIEW'
  | 'CONFIRM_JAVA_INSTALL';

let currentState: ShellState = 'COMMAND';

const propertiesContext = {
  properties: {} as { [key: string]: string },
  keys: [] as string[],
  selectedKey: '',
};

let consoleActiveServer = '';
let logViewServer = '';

// Readline interface
let rl: readline.Interface;

let CLI_VERSION = '1.0.3';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf-8'));
  CLI_VERSION = pkg.version || '1.0.3';
} catch { /* ignore */ }

/**
 * Renders the figlet "MCPANEL" ASCII banner with a chalk gradient.
 */
function renderBanner() {
  const banner = figlet.textSync('MCPANEL', { font: 'Standard' });
  const lines = banner.split('\n');
  const tints = [chalk.cyanBright, chalk.cyan, chalk.greenBright, chalk.green, chalk.green];
  console.log();
  lines.forEach((line, i) => console.log((tints[i] || chalk.green)(line)));
  console.log(chalk.greenBright.bold('  Minecraft Server Manager') + chalk.gray(`   v${CLI_VERSION}`));
}

/**
 * Renders the neofetch / Arch-Linux-style info block for the synced server.
 */
function renderInfo() {
  const server = configManager.getServer();
  const osType = detectOS();
  const java = checkJava(configManager.getConfig().defaultJavaPath);
  const tunnel = playitManager.getStatus().status;
  const running = server ? !!processManager.getActiveServer(server.name) : false;

  const label = (k: string) => chalk.cyanBright.bold((k + ':').padEnd(10));
  const sep = chalk.gray('─'.repeat(50));

  const rows: Array<[string, string]> = [];
  if (server) {
    rows.push(['path', server.path]);
    rows.push(['type', `${server.software} ${server.version}`]);
    rows.push(['ram', server.ram]);
    rows.push(['status', running ? chalk.greenBright('Running') : chalk.gray('Offline')]);
  }
  rows.push(['java', java.installed ? java.version : chalk.red('not found')]);
  rows.push(['os', osType]);
  rows.push(['node', process.version]);
  rows.push([
    'tunnel',
    tunnel === 'Online' ? chalk.greenBright('Online') : tunnel === 'Connecting' ? chalk.yellow('Connecting') : chalk.gray('Offline'),
  ]);

  console.log();
  console.log(sep);
  for (const [k, v] of rows) {
    console.log(`  ${label(k)}${v}`);
  }
  console.log(sep);

  // neofetch-style color palette strip for that terminal-fetch feel.
  const palette =
    chalk.bgRed('   ') + chalk.bgYellow('   ') + chalk.bgGreen('   ') +
    chalk.bgCyan('   ') + chalk.bgBlue('   ') + chalk.bgMagenta('   ') +
    chalk.bgWhite('   ');
  console.log('  ' + palette);
  console.log();
}

/**
 * Full header (banner + info). Used by /clear to redraw the top of the screen.
 */
function renderHeader() {
  renderBanner();
  renderInfo();
}

/**
 * Checks for playit agent binary and auto-downloads if missing.
 */
async function ensurePlayitSetup(): Promise<void> {
  if (playitManager.isBinaryPresent()) {
    console.log(colors.success('Playit detected'));
    return;
  }

  console.log(colors.warning('Playit not found. Downloading playit agent binary...'));

  return new Promise((resolve, reject) => {
    playitManager.downloadBinary((pct) => {
      const width = 30;
      const filled = '='.repeat(Math.round(width * (pct / 100)));
      const empty = '-'.repeat(width - filled.length);
      process.stdout.write(`\rDownloading Playit Agent: [${filled}${empty}] ${pct}%`);
    }).then(() => {
      process.stdout.write('\n');
      console.log(colors.success('Playit downloaded successfully.'));
      resolve();
    }).catch((err) => {
      process.stdout.write('\n');
      console.log(colors.failure(`Playit download failed: ${err.message}`));
      reject(err);
    });
  });
}

// Master list of command templates — single source of truth for both
// tab-completion and "did you mean" suggestions.
const COMMAND_LIST = [
  'help', 'start', 'stop', 'restart', 'console', 'log', 'info', 'sync',
  'stats', 'folder', 'properties', 'java',
  'backup create', 'backup list', 'backup restore',
  'plugins list', 'plugins install', 'plugins remove',
  'setup',
  'tunnel java', 'tunnel bedrock', 'tunnel status', 'tunnel log', 'tunnel stop', 'tunnel reset',
  'playit',
  'dashboard', 'dashboard stop', 'dashboard status',
  'config', 'clear', 'update', 'tray', 'background', 'exit'
];

// Subcommands offered once "<command> " has been typed.
const SUBCOMMANDS: { [cmd: string]: string[] } = {
  'tunnel': ['java', 'bedrock', 'status', 'log', 'stop', 'reset'],
  'backup': ['create', 'list', 'restore'],
  'plugins': ['list', 'install', 'remove'],
  'dashboard': ['stop', 'status'],
};

/** Classic edit distance — powers typo-tolerant "did you mean" suggestions. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(
        dp[i] + 1,                                  // deletion
        dp[i - 1] + 1,                              // insertion
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)      // substitution
      );
      prev = tmp;
    }
  }
  return dp[m];
}

/**
 * Suggests top-level commands for an unknown token. Tries prefix matches first
 * (e.g. "cl" -> "clear"); if none, falls back to edit distance so typos like
 * "claer" or "exti" still resolve to "clear" / "exit".
 */
function suggestCommands(token: string): string[] {
  if (!token) return [];
  const tops = Array.from(new Set(COMMAND_LIST.map(c => c.split(' ')[0])));
  const prefix = tops.filter(c => c.startsWith(token) && c !== token);
  if (prefix.length) return prefix;

  const maxDist = token.length <= 4 ? 2 : 3;
  return tops
    .map(c => ({ c, d: levenshtein(token, c) }))
    .filter(x => x.d <= maxDist && x.c !== token)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(x => x.c);
}

/**
 * Best full-command match for an inline "ghost" autosuggestion (fish/Claude
 * style). Returns the whole command when the current line is a strict prefix of
 * exactly the next thing to type, else '' for no suggestion.
 */
function ghostSuggestion(line: string): string {
  if (!line || line !== line.trimStart()) return '';
  const lower = line.toLowerCase();
  const match = COMMAND_LIST.find(c => c.startsWith(lower) && c.length > line.length);
  return match || '';
}

/**
 * Auto-completion logic
 */
function completer(line: string): [string[], string] {
  const lineTrimmed = line.trim();
  if (currentState !== 'COMMAND') {
    return [[], line];
  }

  const parts = lineTrimmed.split(/\s+/);
  const cmd = parts[0];
  const arg = parts.slice(1).join(' ');

  // Completing the command word itself (e.g. "cl" -> "clear")
  if (!line.includes(' ')) {
    const hits = COMMAND_LIST.filter(c => c.startsWith(lineTrimmed));
    return [hits.length ? hits : COMMAND_LIST, line];
  }

  // Subcommand completion (e.g. "/tunnel " -> java/bedrock/status/...)
  if (SUBCOMMANDS[cmd] && parts.length <= 2) {
    const subs = SUBCOMMANDS[cmd]
      .filter(s => s.startsWith(arg.toLowerCase()))
      .map(s => `${cmd} ${s}`);
    if (subs.length) return [subs, line];
  }

  return [[], line];
}

// Tracks the dim ghost-suffix currently drawn after the cursor (if any), so it
// can be erased before readline redraws or the line is submitted.
let ghostShown = '';

/** Erases the on-screen ghost suffix (cursor is assumed to sit just before it). */
function clearGhost() {
  if (ghostShown) {
    process.stdout.write('\x1b[K'); // clear from cursor to end of line
    ghostShown = '';
  }
}

/**
 * Draws the inline ghost autosuggestion for the current readline buffer. Only
 * shows in COMMAND state, on a TTY, when the cursor is at the end of the line.
 * The suffix is printed dim, then the cursor is moved back so typing continues
 * over it — exactly the "press → to accept" feel of fish/Claude shells.
 */
function renderGhost() {
  if (!process.stdout.isTTY || currentState !== 'COMMAND') {
    return;
  }
  const line = rl.line;
  if (rl.cursor !== line.length) {
    clearGhost();
    return;
  }
  const sugg = ghostSuggestion(line);
  if (!sugg) {
    clearGhost();
    return;
  }
  const remainder = sugg.slice(line.length);
  process.stdout.write('\x1b[K');                              // wipe stale ghost
  process.stdout.write(`\x1b[90m${remainder}\x1b[0m`);         // dim ghost text
  process.stdout.write(`\x1b[${remainder.length}D`);          // cursor back to real position
  ghostShown = remainder;
}

/**
 * Wires inline ghost autosuggestions onto the readline keypress stream. Uses a
 * prepended listener so the stale ghost is erased BEFORE readline reprocesses
 * the key (otherwise Enter would orphan the dim text on the submitted line).
 */
function attachGhostSuggestions() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  readline.emitKeypressEvents(process.stdin);

  process.stdin.prependListener('keypress', (_str: string, key: any) => {
    // Erase any existing ghost first; the cursor is still at the line end here.
    clearGhost();

    if (key && currentState === 'COMMAND' && key.name === 'right' && rl.cursor === rl.line.length) {
      // Right arrow at end of line accepts the suggestion.
      const sugg = ghostSuggestion(rl.line);
      if (sugg && sugg.length > rl.line.length) {
        rl.write(sugg.slice(rl.line.length)); // insert remainder as if typed
      }
    }

    // Re-draw the ghost after readline has finished handling this key.
    setImmediate(renderGhost);
  });
}

/**
 * Persistent History Management
 */
function loadHistory() {
  if (fs.existsSync(HISTORY_PATH)) {
    try {
      const data = fs.readFileSync(HISTORY_PATH, 'utf-8');
      const lines = data.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .reverse(); // readline history is newest-first
      (rl as any).history = lines;
    } catch {
      // Fail silently
    }
  }
}

function saveHistoryLine(line: string) {
  const t = line.trim();
  if (!t || t === 'exit' || t === '/exit') return;
  try {
    fs.appendFileSync(HISTORY_PATH, `${line.trim()}\n`, 'utf-8');
  } catch {
    // Fail silently
  }
}

/**
 * Builds and renders the smart status bar at the bottom
 */
function getStatusBar(): string {
  const server = configManager.getServer();
  const running = server ? !!processManager.getActiveServer(server.name) : false;
  const backupsCount = backupManager.listBackups().length;
  const tunnelStatus = playitManager.getStatus().status;

  // Sync menu state to the system tray
  try {
    trayManager.updateMenu();
  } catch { /* ignore */ }

  const serverStr = !server
    ? colors.gray('none')
    : running ? colors.green('Running') : colors.red('Offline');

  const tStatusStr = tunnelStatus === 'Online'
    ? colors.green('Online')
    : tunnelStatus === 'Connecting'
      ? colors.yellow('Connecting')
      : colors.red('Offline');

  const name = server ? server.name : '—';
  return colors.gray(`[Server: ${colors.bold(name)} ${serverStr} | Backups: ${colors.bold(backupsCount.toString())} | Tunnel: ${tStatusStr}]`);
}

/**
 * Exits console log streaming mode
 */
function exitConsoleMode() {
  if (currentState !== 'CONSOLE') return;
  processManager.unregisterConsoleStream(consoleActiveServer);
  consoleActiveServer = '';
  currentState = 'COMMAND';
  console.log(colors.info('\nReturned to MCPANEL shell.'));
  promptUser();
}

/**
 * Exits the in-place live-log view (fallback used when no terminal could open).
 */
function exitLogView() {
  if (currentState !== 'LOG_VIEW') return;
  processManager.unregisterConsoleStream(logViewServer);
  logViewServer = '';
  currentState = 'COMMAND';
  console.log(colors.info('\nReturned to MCPANEL shell.'));
  promptUser();
}

/**
 * Exits the in-place live tunnel-log view.
 */
function exitTunnelLogView() {
  if (currentState !== 'TUNNEL_LOG_VIEW') return;
  playitManager.unregisterTunnelStream();
  currentState = 'COMMAND';
  console.log(colors.info('\nReturned to MCPANEL shell.'));
  promptUser();
}

/**
 * True only on native Windows when no usable Java is found anywhere — the
 * trigger for the in-app "install Java?" guard before starting a server.
 */
function needsJavaPrompt(): boolean {
  if (process.platform !== 'win32') return false;
  const cfg = configManager.getConfig();
  if (checkJava(cfg.defaultJavaPath).installed) return false;
  return findInstalledJavas().length === 0;
}

/**
 * Prompt loop builder
 */
function promptUser() {
  if (currentState === 'COMMAND') {
    const status = getStatusBar();
    console.log(status);
    rl.setPrompt(chalk.bold.cyan('mcpanel> '));
    rl.prompt();
  } else if (currentState === 'WIZARD_SYNC_PATH') {
    rl.setPrompt(chalk.bold.cyan('server path> '));
    rl.prompt();
  } else if (currentState === 'WIZARD_TUNNEL_TYPE') {
    rl.setPrompt(colors.bold('Tunnel Type (Java or Bedrock): '));
    rl.prompt();
  } else if (currentState === 'PROPERTIES_SELECT') {
    rl.setPrompt(colors.bold('Select property to edit (1-8): '));
    rl.prompt();
  } else if (currentState === 'PROPERTIES_INPUT') {
    rl.setPrompt(colors.bold(`Enter new value for ${propertiesContext.selectedKey}: `));
    rl.prompt();
  } else if (currentState === 'CONFIRM_JAVA_INSTALL') {
    rl.setPrompt(colors.bold('Install Java 25 now? (y/n): '));
    rl.prompt();
  } else if (currentState === 'CONSOLE' || currentState === 'LOG_VIEW' || currentState === 'TUNNEL_LOG_VIEW') {
    // Log/console streaming has no custom prompt.
    rl.setPrompt('');
  }
}

/**
 * Renders the properties edit menu
 */
function showPropertiesMenu() {
  const server = configManager.getServer();
  console.log(`\n${colors.bold(colors.cyan(`Editing Server Properties: ${server?.name ?? ''}`))}`);
  console.log(colors.gray('──────────────────────────────────────────────'));

  propertiesContext.keys.forEach((key, idx) => {
    console.log(`  ${idx + 1}) ${colors.bold(key.padEnd(20))}: ${propertiesContext.properties[key]}`);
  });

  console.log(`  7) ${colors.green('Save and Exit')}`);
  console.log(`  8) ${colors.red('Cancel')}`);
  console.log(colors.gray('──────────────────────────────────────────────'));
}

/**
 * Starts the properties editor flow
 */
function startPropertiesEditor() {
  const server = configManager.getServer();
  if (!server) {
    console.log(colors.failure('No server connected. Use sync <path>.'));
    currentState = 'COMMAND';
    promptUser();
    return;
  }

  const propsPath = path.join(server.path, 'server.properties');
  if (!fs.existsSync(propsPath)) {
    console.log(colors.failure(`server.properties was not found in: ${server.path}`));
    currentState = 'COMMAND';
    promptUser();
    return;
  }

  const loaded = serverManager.readPropertiesFile(propsPath);
  const targetKeys = ['motd', 'difficulty', 'max-players', 'pvp', 'spawn-protection', 'online-mode'];

  propertiesContext.properties = {};
  propertiesContext.keys = targetKeys;

  targetKeys.forEach(k => {
    propertiesContext.properties[k] = loaded[k] !== undefined ? loaded[k] : 'default';
  });

  currentState = 'PROPERTIES_SELECT';
  showPropertiesMenu();
  promptUser();
}

/**
 * Console log streamer mode (interactive — sends typed lines to the server).
 */
function enterConsoleMode() {
  const server = configManager.getServer();
  if (!server) {
    console.log(colors.failure('No server connected.'));
    currentState = 'COMMAND';
    promptUser();
    return;
  }

  if (!processManager.getActiveServer(server.name)) {
    console.log(colors.failure(`Server "${server.name}" is not running. Start it first using start.`));
    currentState = 'COMMAND';
    promptUser();
    return;
  }

  consoleActiveServer = server.name;
  currentState = 'CONSOLE';
  console.log(colors.bold(colors.magenta(`\n--- Entering Live Console: ${server.name} ---`)));
  console.log(colors.gray('Type /exit or /back to return to MCPANEL shell.'));
  console.log(colors.gray('Commands without "/" will be sent directly to the server.\n'));

  const logPath = logger.getServerLogPath(server.name);
  if (fs.existsSync(logPath)) {
    const logs = fs.readFileSync(logPath, 'utf-8').split('\n');
    process.stdout.write(logs.slice(-20).join('\n'));
  }

  processManager.registerConsoleStream(server.name, (data) => {
    process.stdout.write(data);
  });
}

/**
 * /log — streams live server logs read-only inside THIS terminal (like
 * /console, but without sending commands). Type /back or /exit to return.
 */
function handleLogCommand() {
  const server = configManager.getServer();
  if (!server) {
    console.log(colors.failure('No server connected.'));
    return;
  }

  const logPath = logger.getServerLogPath(server.name);
  if (!fs.existsSync(logPath)) {
    try { fs.writeFileSync(logPath, '', 'utf-8'); } catch { /* ignore */ }
  }

  const running = !!processManager.getActiveServer(server.name);
  logViewServer = server.name;
  currentState = 'LOG_VIEW';
  console.log(colors.bold(colors.magenta(`\n--- Live Server Logs: ${server.name} ---`)));
  console.log(colors.gray('Read-only. Type back or exit to return to MCPANEL shell.\n'));
  if (fs.existsSync(logPath)) {
    const logs = fs.readFileSync(logPath, 'utf-8').split('\n');
    process.stdout.write(logs.slice(-30).join('\n') + '\n');
  }
  if (!running) {
    console.log(colors.warning('Server is not running yet — lines will appear once you start it.'));
  }
  processManager.registerConsoleStream(server.name, (data) => {
    process.stdout.write(data);
  });
}

/**
 * /tunnel log — streams the live playit relay log read-only in THIS terminal.
 * Seeds from tunnel.log, then follows the running relay's output. /back to exit.
 */
function enterTunnelLogView() {
  const logPath = logger.getTunnelLogPath();
  currentState = 'TUNNEL_LOG_VIEW';
  console.log(colors.bold(colors.magenta('\n--- Live Tunnel Logs (playit relay) ---')));
  console.log(colors.gray('Read-only. Type back or exit to return to MCPANEL shell.\n'));
  if (fs.existsSync(logPath)) {
    const logs = fs.readFileSync(logPath, 'utf-8').split('\n');
    process.stdout.write(logs.slice(-30).join('\n') + '\n');
  }
  if (!playitManager.isAgentRunning()) {
    console.log(colors.warning('Tunnel agent is not running — start it with tunnel java or tunnel bedrock.'));
  }
  playitManager.registerTunnelStream((data) => {
    process.stdout.write(data);
  });
}

/**
 * dashboard / dashboard stop / dashboard status — launches (or stops) the local
 * web dashboard. Requires a claimed playit agent secret (a real playit.gg
 * account, not a guest tunnel) so the tunnel features are always account-backed.
 */
async function handleDashboardCommand(sub: string) {
  if (sub === 'stop') {
    if (!dashboardServer.isRunning()) {
      console.log(colors.warning('Dashboard is not running.'));
      return;
    }
    await dashboardServer.stop();
    console.log(colors.success('Dashboard stopped.'));
    return;
  }

  if (sub === 'status') {
    const handle = dashboardServer.getHandle();
    console.log(handle
      ? colors.success(`Dashboard running at ${colors.bold(handle.url)}`)
      : colors.warning('Dashboard is not running. Type dashboard to launch it.'));
    return;
  }

  // start / open (default)
  if (dashboardServer.isRunning()) {
    const handle = dashboardServer.getHandle()!;
    openInBrowser(handle.url);
    console.log(colors.success(`Dashboard already running — reopening ${colors.bold(handle.url)}`));
    return;
  }

  const server = configManager.getServer();
  if (!server) {
    console.log(colors.failure('No server connected. Use sync <path> to connect one first.'));
    return;
  }

  // Account gate: ensure the playit agent is claimed to a real account.
  if (!playitManager.getSecret()) {
    console.log(colors.cyan('The dashboard needs your playit.gg account linked (one-time browser approval)...'));
    try {
      await playitManager.ensureSecret({
        onClaimUrl: (url) => {
          const opened = openInBrowser(url);
          console.log(`\n🔗 ${colors.bold('Approve the agent in your browser to link your playit.gg account.')}`);
          if (opened) {
            console.log(colors.gray('Your browser was opened automatically — sign in and click Approve.'));
          } else {
            console.log(colors.gray('Open this link, sign in (free account), and click Approve:'));
          }
          console.log(colors.underline(colors.cyan(url)));
        },
        onStatus: (msg) => console.log(colors.info(msg)),
      });
    } catch (err: any) {
      console.log(colors.failure(`Could not link playit account: ${err.message}`));
      console.log(colors.gray('The dashboard will not launch without an account-backed tunnel.'));
      return;
    }
  }

  try {
    console.log(colors.cyan('Starting the MCPANEL dashboard...'));
    const handle = await dashboardServer.start();
    openInBrowser(handle.url);
    console.log(colors.success(`Dashboard is live at ${colors.bold(handle.url)}`));
    console.log(colors.gray('It opened in your browser automatically. Keep MCPANEL running while you use it.'));
    console.log(colors.gray('Type dashboard stop to shut it down, or dashboard to reopen the tab.'));
  } catch (err: any) {
    console.log(colors.failure(`Failed to start dashboard: ${err.message}`));
  }
}

/**
 * Command line loop orchestrator
 */
async function handleLine(line: string) {
  const trimmed = line.trim();
  saveHistoryLine(line);

  switch (currentState) {
    case 'COMMAND':
      await handleCommandState(trimmed);
      break;

    case 'WIZARD_SYNC_PATH': {
      if (!trimmed) {
        console.log(colors.failure('Please enter a folder path (or type exit to quit).'));
        promptUser();
        break;
      }
      if (trimmed === 'exit' || trimmed === '/exit') {
        process.exit(0);
      }
      try {
        const meta = serverManager.syncServer(trimmed);
        console.log(colors.success(`Connected to "${meta.name}" (${meta.software} ${meta.version})`));
        currentState = 'COMMAND';
        await finishStartup();
      } catch (err: any) {
        console.log(colors.failure(err.message));
        console.log(colors.gray('Enter the full path to a valid Minecraft server folder.'));
        promptUser();
      }
      break;
    }

    case 'WIZARD_TUNNEL_TYPE': {
      const tunnelType = trimmed.toLowerCase();
      if (tunnelType !== 'java' && tunnelType !== 'bedrock') {
        console.log(colors.failure('Unsupported tunnel type. Please enter "java" or "bedrock".'));
        promptUser();
        break;
      }
      currentState = 'COMMAND';
      const output = await router.executeTunnelCreate(tunnelType as any);
      console.log(output);
      promptUser();
      break;
    }

    case 'CONFIRM_JAVA_INSTALL': {
      const ans = trimmed.toLowerCase();
      if (ans === 'y' || ans === 'yes') {
        console.log(colors.cyan('Installing Temurin 25 JDK via winget — this can take a few minutes...'));
        const result = installTemurin25();
        if (!result) {
          currentState = 'COMMAND';
          console.log(colors.failure('Could not install or find Java automatically. Install Temurin 25 from https://adoptium.net, then run start again.'));
          promptUser();
          break;
        }
        configManager.updateSettings({ defaultJavaPath: result.path });
        console.log(colors.success(`Java ${result.version} installed and selected.`));
        currentState = 'COMMAND';
        console.log(colors.cyan('Starting server...'));
        console.log(await router.executeStart());
        promptUser();
      } else {
        currentState = 'COMMAND';
        console.log(colors.info('Start cancelled — Java is required to run a server.'));
        promptUser();
      }
      break;
    }

    case 'PROPERTIES_SELECT':
      if (trimmed === '8') {
        currentState = 'COMMAND';
        console.log(colors.info('Properties edits discarded.'));
        promptUser();
      } else if (trimmed === '7') {
        try {
          serverManager.updateServerProperties(propertiesContext.properties);
          console.log(colors.success('Properties saved successfully.'));
        } catch (err: any) {
          console.log(colors.failure(`Failed to save properties: ${err.message}`));
        }
        currentState = 'COMMAND';
        promptUser();
      } else {
        const idx = parseInt(trimmed, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= propertiesContext.keys.length) {
          console.log(colors.failure('Invalid selection. Select 1-8.'));
          promptUser();
        } else {
          propertiesContext.selectedKey = propertiesContext.keys[idx];
          currentState = 'PROPERTIES_INPUT';
          promptUser();
        }
      }
      break;

    case 'PROPERTIES_INPUT':
      propertiesContext.properties[propertiesContext.selectedKey] = trimmed;
      currentState = 'PROPERTIES_SELECT';
      showPropertiesMenu();
      promptUser();
      break;

    case 'CONSOLE':
      if (trimmed === '/exit' || trimmed === '/back') {
        exitConsoleMode();
      } else if (trimmed.startsWith('/send ')) {
        const cmd = trimmed.substring(6).trim();
        processManager.sendCommand(consoleActiveServer, cmd);
      } else {
        processManager.sendCommand(consoleActiveServer, trimmed);
      }
      break;

    case 'LOG_VIEW':
      // Read-only: only back or exit leaves; everything else is ignored.
      if (trimmed === 'exit' || trimmed === 'back' || trimmed === '/exit' || trimmed === '/back') {
        exitLogView();
      }
      break;

    case 'TUNNEL_LOG_VIEW':
      // Read-only: only back or exit leaves; everything else is ignored.
      if (trimmed === 'exit' || trimmed === 'back' || trimmed === '/exit' || trimmed === '/back') {
        exitTunnelLogView();
      }
      break;
  }
}

/**
 * Handle execution of commands in STATE_COMMAND
 */
async function handleCommandState(line: string) {
  if (!line) {
    promptUser();
    return;
  }

  const parts = line.split(/\s+/);
  // Commands have no leading slash, but tolerate one for muscle memory / old history.
  const cmd = parts[0].toLowerCase().replace(/^\//, '');
  const args = parts.slice(1);

  switch (cmd) {
    case 'help':
      console.log(router.getHelpText());
      break;

    case 'clear':
      try {
        fs.writeFileSync(HISTORY_PATH, '', 'utf-8');
        if (rl) {
          (rl as any).history = [];
        }
        // \x1b[2J = clear screen, \x1b[3J = clear scrollback, \x1b[H = cursor home
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
        renderHeader();
        console.log(colors.success('Command output and history cleared.'));
      } catch (err: any) {
        console.log(colors.failure(`Failed to clear: ${err.message}`));
      }
      break;

    case 'tray':
    case 'background': {
      console.log(colors.info('\nPutting MCPANEL in the background...'));
      console.log(colors.gray('The terminal window will be hidden. Use the system tray icon to restore it.'));
      const success = trayManager.hideConsole();
      if (!success) {
        console.log(colors.failure('Failed to hide console window. Ensure you are running in a supported GUI environment.'));
      }
      break;
    }

    case 'exit':
      logger.info('Exiting MCPANEL manager.');
      backupScheduler.stop();
      await dashboardServer.stop();
      playitManager.stopTunnel();
      console.log(colors.cyan('\nStopping the server if running...'));
      {
        const active = Array.from(processManager.getActiveServers().keys());
        for (const serverName of active) {
          await processManager.stopServer(serverName);
        }
      }
      console.log(colors.success('Goodbye!'));
      process.exit(0);
      break;

    case 'sync':
      if (args.length === 0) {
        console.log(colors.failure('Syntax: sync <path-to-server-folder>'));
      } else {
        console.log(router.executeSync(args.join(' ')));
      }
      break;

    case 'info':
    case 'path':
      console.log(router.executeInfo());
      break;

    case 'start':
      if (needsJavaPrompt()) {
        currentState = 'CONFIRM_JAVA_INSTALL';
        console.log(colors.warning('Java 25 is required to start a server, but none was found on this Windows PC.'));
        promptUser();
        break;
      }
      console.log(colors.cyan('Starting server...'));
      console.log(await router.executeStart());
      break;

    case 'stop':
      console.log(colors.cyan('Stopping server...'));
      console.log(await router.executeStop());
      break;

    case 'restart':
      console.log(colors.cyan('Restarting server...'));
      console.log(await router.executeRestart());
      break;

    case 'console':
      enterConsoleMode();
      break;

    case 'log':
      handleLogCommand();
      break;

    case 'playit':
      enterTunnelLogView();
      break;

    case 'dashboard':
    case 'panel':
    case 'web':
      await handleDashboardCommand((args[0] || '').toLowerCase());
      break;

    case 'stats':
      console.log(await router.executeStats());
      break;

    case 'folder':
      console.log(router.executeFolder());
      break;

    case 'properties':
      startPropertiesEditor();
      break;

    case 'java':
      console.log(router.executeJava(args.length ? args.join(' ') : undefined));
      break;

    case 'update':
      console.log(await router.executeUpdate());
      break;

    case 'config':
      console.log(router.executeConfig());
      break;

    case 'backup':
      if (args.length === 0) {
        console.log(colors.failure('Syntax: backup [create|list|restore]'));
      } else if (args[0].toLowerCase() === 'create') {
        console.log(router.executeBackupCreate());
      } else if (args[0].toLowerCase() === 'list') {
        console.log(router.executeBackupList());
      } else if (args[0].toLowerCase() === 'restore') {
        if (!args[1]) console.log(colors.failure('Syntax: backup restore <backup-id>'));
        else console.log(router.executeBackupRestore(args[1]));
      } else {
        console.log(colors.failure('Syntax: backup [create|list|restore]'));
      }
      break;

    case 'plugins':
      if (args.length === 0) {
        console.log(colors.failure('Syntax: plugins [list|install|remove]'));
      } else if (args[0].toLowerCase() === 'list') {
        console.log(router.executePluginsList());
      } else if (args[0].toLowerCase() === 'install') {
        if (!args[1]) console.log(colors.failure('Syntax: plugins install <plugin-url>'));
        else console.log(await router.executePluginsInstall(args[1]));
      } else if (args[0].toLowerCase() === 'remove') {
        if (!args[1]) console.log(colors.failure('Syntax: plugins remove <plugin-name>'));
        else console.log(router.executePluginsRemove(args[1]));
      } else {
        console.log(colors.failure('Syntax: plugins [list|install|remove]'));
      }
      break;

    case 'setup':
      console.log(await router.executeSetup());
      break;

    case 'tunnel': {
      const sub = (args[0] || '').toLowerCase();
      if (!sub) {
        console.log(colors.failure('Syntax: tunnel [java|bedrock|status|log|stop|reset]'));
      } else if (sub === 'java' || sub === 'bedrock') {
        console.log(await router.executeTunnelCreate(sub));
      } else if (sub === 'create') {
        const type = (args[1] || '').toLowerCase();
        if (type === 'java' || type === 'bedrock') {
          console.log(await router.executeTunnelCreate(type));
        } else {
          currentState = 'WIZARD_TUNNEL_TYPE';
        }
      } else if (sub === 'stop') {
        console.log(router.executeTunnelStop());
      } else if (sub === 'status') {
        console.log(router.executeTunnelStatus());
      } else if (sub === 'log') {
        enterTunnelLogView();
      } else if (sub === 'reset') {
        console.log(await router.executeTunnelReset());
      } else {
        console.log(colors.failure('Syntax: tunnel [java|bedrock|status|log|stop|reset]'));
      }
      break;
    }

    default: {
      const suggestions = suggestCommands(cmd);
      if (suggestions.length) {
        console.log(colors.failure(`Unknown command: "${cmd}".`) + ' ' + colors.gray(`Did you mean: ${suggestions.join(', ')} ?`));
      } else {
        console.log(colors.failure(`Unknown command: "${cmd}". Type help for available commands.`));
      }
      break;
    }
  }

  if (currentState === 'COMMAND') {
    promptUser();
  }
}

/**
 * Renders the server info screen, ensures playit is ready, and drops into the
 * command prompt. Shared by the "already synced" and "just synced" paths.
 */
async function finishStartup() {
  renderInfo();

  try {
    await ensurePlayitSetup();
  } catch {
    // Continue despite download failure (tunnel will fail until resolved).
  }

  console.log('\nType ' + chalk.cyan('help') + ' for available commands\n');
  currentState = 'COMMAND';
  promptUser();
}

/**
 * Prints a one-time-per-launch notice if a newer version is on npm. Fail-silent
 * and cached, so it never slows down or blocks startup.
 */
async function showUpdateNotice() {
  try {
    const info = await checkForUpdate();
    if (info && info.updateAvailable) {
      console.log();
      console.log(chalk.yellow('  ⚡ Update available: ') + chalk.gray(info.current) + chalk.gray(' → ') + chalk.greenBright.bold(info.latest));
      console.log(chalk.gray('     Update with: ') + chalk.cyan(`npm i -g ${info.name}@latest`));
    }
  } catch {
    // Never let an update check break startup.
  }
}

/**
 * Main application setup
 */
async function main() {
  renderBanner();
  await showUpdateNotice();

  // Start the background system tray loop
  await trayManager.start();

  // Resume automatic backups from saved settings (runs whether or not the
  // dashboard is open, for as long as MCPANEL is running).
  backupScheduler.start();

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: completer,
  });

  loadHistory();
  attachGhostSuggestions();

  // Realtime: when the server or tunnel state changes — including from the web
  // dashboard — redraw the CLI status line so it's never stale. The CLI and the
  // dashboard share the same manager instances, so both reflect the same state.
  const announceStateLine = (msg: string) => {
    if (currentState !== 'COMMAND' || !process.stdout.isTTY) return;
    clearGhost();
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    console.log(colors.info(msg));
    console.log(getStatusBar());
    rl.prompt(true); // re-render prompt, preserving any typed input
  };

  let lastRunning = false;
  processManager.onStateChange(() => {
    const srv = configManager.getServer();
    const running = srv ? !!processManager.getActiveServer(srv.name) : false;
    if (running === lastRunning) return; // ignore intermediate spawn→running churn
    lastRunning = running;
    announceStateLine(`Server is now ${running ? 'Running' : 'Offline'}.`);
  });

  playitManager.onStatusChange(() => {
    announceStateLine(`Tunnel is now ${playitManager.getStatus().status}.`);
  });

  rl.on('line', (line) => {
    handleLine(line).catch((err) => {
      console.error(colors.failure(`Uncaught error in command loop: ${err.message}`));
      promptUser();
    });
  });

  rl.on('SIGINT', () => {
    if (currentState === 'CONSOLE') {
      exitConsoleMode();
    } else if (currentState === 'LOG_VIEW') {
      exitLogView();
    } else if (currentState === 'WIZARD_SYNC_PATH') {
      console.log(colors.info('\nType exit to quit, or enter a server folder path.'));
      promptUser();
    } else if (currentState !== 'COMMAND') {
      currentState = 'COMMAND';
      console.log(colors.info('\nCancelled.'));
      promptUser();
    } else {
      console.log(colors.info('\nType exit to exit MCPANEL.'));
      promptUser();
    }
  });

  // Single-server model: require a connected server folder before commands.
  const server = configManager.getServer();
  const valid = server && fs.existsSync(server.path);

  if (!valid) {
    if (server && !fs.existsSync(server.path)) {
      console.log(colors.warning(`\nSaved server folder no longer exists: ${server.path}`));
    }
    console.log(colors.info('\nNo Minecraft server is connected yet.'));
    console.log(colors.gray('Enter the full path to your server folder to connect it.\n'));
    currentState = 'WIZARD_SYNC_PATH';
    promptUser();
  } else {
    await finishStartup();
  }
}

main().catch((err) => {
  console.error(colors.failure(`Fatal initialization error: ${err.stack || err}`));
  process.exit(1);
});
