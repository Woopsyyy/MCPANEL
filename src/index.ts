#!/usr/bin/env node

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import figlet from 'figlet';
import { ConfigManager, APP_ROOT } from './config/configManager';
import { ProcessManager } from './services/processManager';
import { ServerManager } from './managers/serverManager';
import { BackupManager } from './managers/backupManager';
import { PlayitManager } from './managers/playitManager';
import { CommandRouter } from './commands/commandRouter';
import * as colors from './utils/colors';
import { detectOS, checkJava, openTerminalTail } from './utils/helpers';
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

const HISTORY_PATH = path.join(APP_ROOT, 'logs', '.history');

// State machine states
type ShellState =
  | 'COMMAND'
  | 'WIZARD_SYNC_PATH'
  | 'WIZARD_TUNNEL_TYPE'
  | 'PROPERTIES_SELECT'
  | 'PROPERTIES_INPUT'
  | 'CONSOLE'
  | 'LOG_VIEW';

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
  '/help', '/start', '/stop', '/restart', '/console', '/log', '/info', '/sync',
  '/stats', '/folder', '/properties', '/java',
  '/backup create', '/backup list', '/backup restore',
  '/plugins list', '/plugins install', '/plugins remove',
  '/setup',
  '/tunnel java', '/tunnel bedrock', '/tunnel status', '/tunnel stop', '/tunnel reset',
  '/config', '/clear', '/update', '/tray', '/background', '/exit'
];

// Subcommands offered once "<command> " has been typed.
const SUBCOMMANDS: { [cmd: string]: string[] } = {
  '/tunnel': ['java', 'bedrock', 'status', 'stop', 'reset'],
  '/backup': ['create', 'list', 'restore'],
  '/plugins': ['list', 'install', 'remove'],
};

/** Returns top-level commands that share a prefix with the typed token. */
function suggestCommands(token: string): string[] {
  if (!token || !token.startsWith('/')) return [];
  const tops = Array.from(new Set(COMMAND_LIST.map(c => c.split(' ')[0])));
  return tops.filter(c => c.startsWith(token) && c !== token);
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

  // Completing the command word itself (e.g. "/cl" -> "/clear")
  if (line.startsWith('/') && !line.includes(' ')) {
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
  if (!line || line.trim().length === 0 || line.startsWith('/exit')) return;
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
  } else if (currentState === 'CONSOLE' || currentState === 'LOG_VIEW') {
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
    console.log(colors.failure('No server connected. Use /sync <path>.'));
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
    console.log(colors.failure(`Server "${server.name}" is not running. Start it first using /start.`));
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
 * /log — opens live server logs in a NEW terminal window (tail -f). Falls back
 * to a read-only in-place stream if no terminal emulator could be launched.
 */
function handleLogCommand() {
  const server = configManager.getServer();
  if (!server) {
    console.log(colors.failure('No server connected.'));
    return;
  }

  const logPath = logger.getServerLogPath(server.name);
  // Ensure the file exists so `tail -f` has something to follow.
  if (!fs.existsSync(logPath)) {
    try { fs.writeFileSync(logPath, '', 'utf-8'); } catch { /* ignore */ }
  }

  const running = !!processManager.getActiveServer(server.name);
  const opened = openTerminalTail(logPath, `MCPANEL Logs - ${server.name}`);

  if (opened) {
    console.log(colors.success('Live server logs opened in a new terminal window.'));
    if (!running) {
      console.log(colors.warning('Server is not running yet — log lines will appear once you /start it.'));
    }
    return;
  }

  // Fallback: stream the logs read-only inside this shell.
  console.log(colors.warning('Could not open a separate terminal window — showing logs here instead.'));
  logViewServer = server.name;
  currentState = 'LOG_VIEW';
  console.log(colors.bold(colors.magenta(`\n--- Live Logs: ${server.name} (type /back to return) ---`)));
  if (fs.existsSync(logPath)) {
    const logs = fs.readFileSync(logPath, 'utf-8').split('\n');
    process.stdout.write(logs.slice(-30).join('\n') + '\n');
  }
  processManager.registerConsoleStream(server.name, (data) => {
    process.stdout.write(data);
  });
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
        console.log(colors.failure('Please enter a folder path (or type /exit to quit).'));
        promptUser();
        break;
      }
      if (trimmed === '/exit') {
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
      // Read-only: only /back or /exit leaves; everything else is ignored.
      if (trimmed === '/exit' || trimmed === '/back') {
        exitLogView();
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
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (!line.startsWith('/')) {
    console.log(colors.failure(`Unknown command: "${line}". All commands must start with "/". Type /help for assistance.`));
    promptUser();
    return;
  }

  switch (cmd) {
    case '/help':
      console.log(router.getHelpText());
      break;

    case '/clear':
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

    case '/tray':
    case '/background': {
      console.log(colors.info('\nPutting MCPANEL in the background...'));
      console.log(colors.gray('The terminal window will be hidden. Use the system tray icon to restore it.'));
      const success = trayManager.hideConsole();
      if (!success) {
        console.log(colors.failure('Failed to hide console window. Ensure you are running in a supported GUI environment.'));
      }
      break;
    }

    case '/exit':
      logger.info('Exiting MCPANEL manager.');
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

    case '/sync':
      if (args.length === 0) {
        console.log(colors.failure('Syntax: /sync <path-to-server-folder>'));
      } else {
        console.log(router.executeSync(args.join(' ')));
      }
      break;

    case '/info':
    case '/path':
      console.log(router.executeInfo());
      break;

    case '/start':
      console.log(colors.cyan('Starting server...'));
      console.log(await router.executeStart());
      break;

    case '/stop':
      console.log(colors.cyan('Stopping server...'));
      console.log(await router.executeStop());
      break;

    case '/restart':
      console.log(colors.cyan('Restarting server...'));
      console.log(await router.executeRestart());
      break;

    case '/console':
      enterConsoleMode();
      break;

    case '/log':
      handleLogCommand();
      break;

    case '/stats':
      console.log(await router.executeStats());
      break;

    case '/folder':
      console.log(router.executeFolder());
      break;

    case '/properties':
      startPropertiesEditor();
      break;

    case '/java':
      console.log(router.executeJava(args.length ? args.join(' ') : undefined));
      break;

    case '/update':
      console.log(await router.executeUpdate());
      break;

    case '/config':
      console.log(router.executeConfig());
      break;

    case '/backup':
      if (args.length === 0) {
        console.log(colors.failure('Syntax: /backup [create|list|restore]'));
      } else if (args[0].toLowerCase() === 'create') {
        console.log(router.executeBackupCreate());
      } else if (args[0].toLowerCase() === 'list') {
        console.log(router.executeBackupList());
      } else if (args[0].toLowerCase() === 'restore') {
        if (!args[1]) console.log(colors.failure('Syntax: /backup restore <backup-id>'));
        else console.log(router.executeBackupRestore(args[1]));
      } else {
        console.log(colors.failure('Syntax: /backup [create|list|restore]'));
      }
      break;

    case '/plugins':
      if (args.length === 0) {
        console.log(colors.failure('Syntax: /plugins [list|install|remove]'));
      } else if (args[0].toLowerCase() === 'list') {
        console.log(router.executePluginsList());
      } else if (args[0].toLowerCase() === 'install') {
        if (!args[1]) console.log(colors.failure('Syntax: /plugins install <plugin-url>'));
        else console.log(await router.executePluginsInstall(args[1]));
      } else if (args[0].toLowerCase() === 'remove') {
        if (!args[1]) console.log(colors.failure('Syntax: /plugins remove <plugin-name>'));
        else console.log(router.executePluginsRemove(args[1]));
      } else {
        console.log(colors.failure('Syntax: /plugins [list|install|remove]'));
      }
      break;

    case '/setup':
      console.log(await router.executeSetup());
      break;

    case '/tunnel': {
      const sub = (args[0] || '').toLowerCase();
      if (!sub) {
        console.log(colors.failure('Syntax: /tunnel [java|bedrock|status|stop|reset]'));
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
      } else if (sub === 'reset') {
        console.log(await router.executeTunnelReset());
      } else {
        console.log(colors.failure('Syntax: /tunnel [java|bedrock|status|stop|reset]'));
      }
      break;
    }

    default: {
      const suggestions = suggestCommands(cmd);
      if (suggestions.length) {
        console.log(colors.failure(`Unknown command: "${cmd}".`) + ' ' + colors.gray(`Did you mean: ${suggestions.join(', ')} ?`));
      } else {
        console.log(colors.failure(`Unknown command: "${cmd}". Type /help for available commands.`));
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

  console.log('\nType ' + chalk.cyan('/help') + ' for available commands\n');
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

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: completer,
  });

  loadHistory();

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
      console.log(colors.info('\nType /exit to quit, or enter a server folder path.'));
      promptUser();
    } else if (currentState !== 'COMMAND') {
      currentState = 'COMMAND';
      console.log(colors.info('\nCancelled.'));
      promptUser();
    } else {
      console.log(colors.info('\nType /exit to exit MCPANEL.'));
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
