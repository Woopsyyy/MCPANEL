import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/configManager';
import { ProcessManager } from '../services/processManager';
import { ServerManager } from '../managers/serverManager';
import { BackupManager } from '../managers/backupManager';
import { PlayitManager } from '../managers/playitManager';
import * as colors from '../utils/colors';
import { getSystemStats, openInBrowser, openInFileExplorer, getDirSize, checkJava, findInstalledJavas } from '../utils/helpers';
import { downloadFile } from '../services/downloadService';
import pidusage from 'pidusage';

export class CommandRouter {
  private configManager: ConfigManager;
  private processManager: ProcessManager;
  private serverManager: ServerManager;
  private backupManager: BackupManager;
  private playitManager: PlayitManager;

  constructor(
    configManager: ConfigManager,
    processManager: ProcessManager,
    serverManager: ServerManager,
    backupManager: BackupManager,
    playitManager: PlayitManager
  ) {
    this.configManager = configManager;
    this.processManager = processManager;
    this.serverManager = serverManager;
    this.backupManager = backupManager;
    this.playitManager = playitManager;
  }

  /**
   * Returns grouped help command menu.
   */
  public getHelpText(): string {
    return [
      colors.bold(colors.cyan('\nMCPANEL Help Menu')),
      colors.gray('──────────────────────────────────────────────'),
      colors.bold(colors.green('Server Commands')),
      '  /start                       - Start the Minecraft server',
      '  /stop                        - Stop the server gracefully',
      '  /restart                     - Restart the server',
      '  /console                     - Enter the interactive server console',
      '  /log                         - Open live server logs in a new terminal window',
      '  /info                        - Show server path, type, version and status',
      '  /sync <path>                 - Connect a different server folder',
      '  /properties                  - Edit server.properties interactively',
      '',
      colors.bold(colors.green('Tunnel Commands (Playit.gg)')),
      '  /tunnel java                 - Auto-create & start a Java tunnel, returns address',
      '  /tunnel bedrock              - Auto-create & start a Bedrock tunnel, returns address',
      '  /tunnel status               - Check tunnel status, address and latency',
      '  /tunnel stop                 - Stop the playit tunnel agent',
      '  /tunnel reset                - Clear saved agent secret (re-claim on next tunnel)',
      '',
      colors.bold(colors.green('Backup Commands')),
      '  /backup create               - Create a backup ZIP of the server',
      '  /backup list                 - List all available backups',
      '  /backup restore <id>         - Restore the server from a backup ID',
      '',
      colors.bold(colors.green('Plugin Commands')),
      '  /plugins list                - List installed plugins',
      '  /plugins install <url>       - Download and install a plugin JAR',
      '  /plugins remove <name>       - Remove an installed plugin',
      '',
      colors.bold(colors.green('System Commands')),
      '  /stats                       - System stats + CPU/RAM/disk of the server',
      '  /java [path]                 - Show/list Java runtimes, or set the one used to launch',
      '  /folder                      - Open the server folder in the file explorer',
      '  /clear                       - Clear the screen, scrollback and command history',
      '  /config                      - View active application config.json',
      '  /exit                        - Close MCPANEL server manager',
      colors.gray('──────────────────────────────────────────────\n')
    ].join('\n');
  }

  /**
   * Executes /sync <path> — connects/validates a server folder.
   */
  public executeSync(dir: string): string {
    try {
      const meta = this.serverManager.syncServer(dir);
      return [
        colors.success('Minecraft server connected'),
        `Name:     ${colors.bold(meta.name)}`,
        `Path:     ${meta.path}`,
        `Type:     ${meta.software} ${meta.version}`,
        colors.success('Server is ready.')
      ].join('\n');
    } catch (err: any) {
      return colors.failure(err.message);
    }
  }

  /**
   * Executes /info (and /path) — details of the managed server.
   */
  public executeInfo(): string {
    const server = this.configManager.getServer();
    if (!server) {
      return colors.failure('No server connected. Use /sync <path> to connect one.');
    }

    const activeInfo = this.processManager.getActiveServer(server.name);
    const statusStr = activeInfo
      ? (activeInfo.status === 'Running' ? colors.green('Running') : colors.yellow('Starting'))
      : colors.red('Offline');

    return [
      '\n' + colors.bold(colors.cyan('Server Details')),
      `Name:        ${colors.bold(server.name)}`,
      `Path:        ${server.path}`,
      `Type:        ${server.software} ${server.version}`,
      `RAM:         ${server.ram}`,
      `Status:      ${statusStr}\n`
    ].join('\n');
  }

  /**
   * Executes /start command.
   */
  public async executeStart(): Promise<string> {
    const server = this.configManager.getServer();
    if (!server) {
      return colors.failure('No server connected. Use /sync <path> to connect one.');
    }

    if (this.processManager.getActiveServer(server.name)) {
      return colors.warning(`Server "${server.name}" is already running.`);
    }

    if (!fs.existsSync(server.path)) {
      return colors.failure(`Server folder no longer exists: ${server.path}`);
    }

    const jarPath = path.join(server.path, 'server.jar');
    let resolvedJar = jarPath;
    if (!fs.existsSync(jarPath)) {
      const jarFiles = fs.readdirSync(server.path).filter(f => f.endsWith('.jar'));
      if (jarFiles.length === 0) {
        return colors.failure(`Missing server jar in folder: ${server.path}`);
      }
      resolvedJar = path.join(server.path, jarFiles[0]);
    }

    try {
      await this.processManager.startServer(
        server.name,
        server.path,
        resolvedJar,
        server.ram,
        this.configManager.getConfig().defaultJavaPath
      );
      return colors.success(`Server "${server.name}" started. Use /log to watch live logs or /console to enter the console.`);
    } catch (err: any) {
      return colors.failure(`Failed to start server: ${err.message}`);
    }
  }

  /**
   * Executes /stop command.
   */
  public async executeStop(): Promise<string> {
    const server = this.configManager.getServer();
    if (!server) {
      return colors.failure('No server connected.');
    }
    const success = await this.processManager.stopServer(server.name);
    return success
      ? colors.success(`Server "${server.name}" stopped.`)
      : colors.warning(`Server "${server.name}" is not currently running.`);
  }

  /**
   * Executes /restart command.
   */
  public async executeRestart(): Promise<string> {
    const server = this.configManager.getServer();
    if (!server) {
      return colors.failure('No server connected.');
    }
    if (this.processManager.getActiveServer(server.name)) {
      await this.executeStop();
    }
    return this.executeStart();
  }

  /**
   * Executes /stats — system stats plus the managed server's resource usage.
   */
  public async executeStats(): Promise<string> {
    const stats = getSystemStats();
    const server = this.configManager.getServer();
    const info = server ? this.processManager.getActiveServer(server.name) : undefined;
    const tunnelStatus = this.playitManager.getStatus();

    const out = [
      '\n' + colors.bold(colors.cyan('System Performance Statistics')),
      `CPU Usage:       ${colors.bold(`${stats.cpuUsage}%`)}`,
      `RAM Usage:       ${colors.bold(`${stats.usedMemGB} GB / ${stats.totalMemGB} GB`)} (${stats.memUsagePct}%)`,
      `System Uptime:   ${Math.floor(stats.uptimeSeconds / 3600)}h ${Math.floor((stats.uptimeSeconds % 3600) / 60)}m`,
      `Playit Tunnel:   ${tunnelStatus.status === 'Online' ? colors.green('Online') : colors.red('Offline')}`,
    ];

    if (server) {
      const diskMB = (getDirSize(server.path) / (1024 * 1024)).toFixed(1);
      out.push('');
      out.push(colors.bold(colors.cyan(`Server: ${server.name}`)));
      out.push(`Status:    ${info ? colors.green('Running') : colors.red('Offline')}`);
      out.push(`Disk Size: ${colors.bold(`${diskMB} MB`)}`);
      if (info) {
        const usage = await this.processUsage(info.pid);
        out.push(`PID:       ${info.pid}`);
        out.push(`CPU:       ${colors.bold(`${usage.cpu}%`)}`);
        out.push(`RAM:       ${colors.bold(`${usage.ramMB} MB`)}`);
        out.push(`Uptime:    ${Math.floor((Date.now() - info.startTime) / 60000)}m`);
      }
    }

    out.push('');
    return out.join('\n');
  }

  /** Cross-platform per-process CPU%/RAM via pidusage; safe on failure. */
  private async processUsage(pid: number): Promise<{ cpu: string; ramMB: string }> {
    try {
      // pidusage needs two samples to compute a CPU delta — the first reads 0,
      // so prime it, wait briefly, then read the real value.
      await pidusage(pid);
      await new Promise((r) => setTimeout(r, 250));
      const stat = await pidusage(pid);
      return { cpu: stat.cpu.toFixed(1), ramMB: (stat.memory / (1024 * 1024)).toFixed(1) };
    } catch {
      return { cpu: 'N/A', ramMB: 'N/A' };
    }
  }

  /**
   * Executes /folder — opens the server's directory in the OS file explorer.
   */
  public executeFolder(): string {
    const server = this.configManager.getServer();
    if (!server) {
      return colors.failure('No server connected.');
    }
    if (!fs.existsSync(server.path)) {
      return colors.failure(`Server directory does not exist: ${server.path}`);
    }
    const opened = openInFileExplorer(server.path);
    return opened
      ? colors.success(`Opening folder for "${server.name}": ${server.path}`)
      : colors.warning(`Could not launch a file explorer. Path: ${server.path}`);
  }

  /**
   * Executes /backup create
   */
  public executeBackupCreate(): string {
    const server = this.configManager.getServer();
    if (!server) {
      return colors.failure('No server connected.');
    }
    if (this.processManager.getActiveServer(server.name)) {
      return colors.failure(`Server "${server.name}" is currently running. Stop it first to prevent world corruption.`);
    }

    try {
      const meta = this.backupManager.createBackup();
      return colors.success(`Backup created: ${meta.name} (${(meta.sizeBytes / 1024 / 1024).toFixed(2)} MB)`);
    } catch (err: any) {
      return colors.failure(`Backup failed: ${err.message}`);
    }
  }

  /**
   * Executes /backup list
   */
  public executeBackupList(): string {
    const list = this.backupManager.listBackups();
    if (list.length === 0) {
      return colors.warning('No backups found.');
    }

    const rows = [
      colors.bold(
        `${'Backup ID (Filename)'.padEnd(50)}${'Server'.padEnd(15)}${'Size (MB)'.padEnd(12)}${'Created At'.padEnd(20)}`
      ),
      colors.gray('─'.repeat(97))
    ];

    for (const b of list) {
      const sizeMB = (b.sizeBytes / (1024 * 1024)).toFixed(2);
      const shortId = b.id.length > 47 ? b.id.substring(0, 44) + '...' : b.id;
      rows.push(
        `${shortId.padEnd(50)}${b.serverName.padEnd(15)}${sizeMB.padEnd(12)}${new Date(b.createdAt).toLocaleDateString().padEnd(20)}`
      );
    }

    return '\n' + rows.join('\n') + '\n';
  }

  /**
   * Executes /backup restore <backup-id>
   */
  public executeBackupRestore(backupId: string): string {
    const server = this.configManager.getServer();
    if (!server) {
      return colors.failure('No server connected.');
    }
    if (this.processManager.getActiveServer(server.name)) {
      return colors.failure(`Server "${server.name}" is currently running. Stop it first before restoring.`);
    }

    try {
      this.backupManager.restoreBackup(backupId);
      return colors.success(`Backup successfully restored to "${server.name}".`);
    } catch (err: any) {
      return colors.failure(`Restoration failed: ${err.message}`);
    }
  }

  /**
   * Executes /plugins list
   */
  public executePluginsList(): string {
    const server = this.configManager.getServer();
    if (!server) {
      return colors.failure('No server connected.');
    }

    const pluginsDir = path.join(server.path, 'plugins');
    if (!fs.existsSync(pluginsDir)) {
      return colors.warning(`No plugins folder found. Start the server once to generate it, or create it at: ${pluginsDir}`);
    }

    const plugins = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.jar'));
    if (plugins.length === 0) {
      return colors.warning(`No plugins (.jar) installed on "${server.name}".`);
    }

    const rows = ['\n' + colors.bold(colors.cyan(`Plugins installed on ${server.name}:`))];
    plugins.forEach((p, idx) => rows.push(`  ${idx + 1}. ${p}`));
    return rows.join('\n') + '\n';
  }

  /**
   * Executes /plugins install <plugin-url>
   */
  public async executePluginsInstall(url: string): Promise<string> {
    const server = this.configManager.getServer();
    if (!server) {
      return colors.failure('No server connected.');
    }

    const pluginsDir = path.join(server.path, 'plugins');
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }

    let fileName: string;
    try {
      fileName = path.basename(new URL(url).pathname);
    } catch {
      return colors.failure('Invalid plugin URL.');
    }
    if (!fileName || !fileName.endsWith('.jar')) {
      fileName = 'downloaded-plugin.jar';
    }

    const destPath = path.join(pluginsDir, fileName);
    console.log(colors.cyan(`Downloading plugin to ${destPath}...`));

    try {
      await downloadFile(url, destPath);
      return colors.success(`Plugin "${fileName}" installed successfully to "${server.name}".`);
    } catch (err: any) {
      return colors.failure(`Failed to install plugin: ${err.message}`);
    }
  }

  /**
   * Executes /plugins remove <plugin-jar-name>
   */
  public executePluginsRemove(pluginName: string): string {
    const server = this.configManager.getServer();
    if (!server) {
      return colors.failure('No server connected.');
    }

    const pluginsDir = path.join(server.path, 'plugins');
    if (!fs.existsSync(pluginsDir)) {
      return colors.failure('No plugins folder exists.');
    }

    let targetFile = pluginName;
    if (!targetFile.endsWith('.jar')) {
      targetFile += '.jar';
    }

    // Security sanitization (basename) to prevent directory traversal.
    const cleanFileName = path.basename(targetFile);
    const targetPath = path.join(pluginsDir, cleanFileName);

    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
      return colors.success(`Plugin "${cleanFileName}" removed from "${server.name}".`);
    }
    return colors.failure(`Plugin "${cleanFileName}" was not found on "${server.name}".`);
  }

  /**
   * Executes /tunnel stop
   */
  public executeTunnelStop(): string {
    const success = this.playitManager.stopTunnel();
    return success
      ? colors.success('Playit tunnel agent stopped.')
      : colors.warning('Playit tunnel is not currently running.');
  }

  /**
   * Executes /tunnel status
   */
  public executeTunnelStatus(): string {
    const status = this.playitManager.getStatus();

    let statusStr = colors.red('Offline');
    if (status.status === 'Online') {
      statusStr = colors.green('Online');
    } else if (status.status === 'Connecting') {
      statusStr = colors.yellow('Connecting');
    }

    const output = [
      '\n' + colors.bold(colors.cyan('Playit.gg Tunnel Status')),
      `Tunnel Address: ${colors.bold(status.address)}`,
      `Port:           ${status.port}`,
      `Status:         ${statusStr}`,
      `Latency:        ${status.latency}`
    ];

    if (status.type) {
      output.push(`Type:           ${status.type === 'java' ? 'Minecraft Java' : 'Minecraft Bedrock'}`);
    }

    if (status.address && status.address !== 'None') {
      output.push(`\n🎮 Connect at: ${colors.bold(colors.green(`${status.address}:${status.port}`))}`);
    }

    output.push('');
    return output.join('\n');
  }

  /**
   * Executes /java [path] — shows the current Java, lists detected JVMs, or
   * (with an argument) validates and sets the Java used to launch the server.
   * Newer Minecraft versions require newer Java (e.g. MC 26.x needs Java 25).
   */
  public executeJava(newPath?: string): string {
    if (!newPath) {
      const current = this.configManager.getConfig().defaultJavaPath;
      const info = checkJava(current);
      const lines = [
        '\n' + colors.bold(colors.cyan('Java Runtime')),
        `Current:  ${colors.bold(current)}`,
        `Version:  ${info.installed ? colors.green(info.version) : colors.red('not found')}`,
      ];

      const detected = findInstalledJavas();
      if (detected.length > 0) {
        lines.push('');
        lines.push(colors.bold(colors.cyan('Detected JVMs:')));
        for (const j of detected) {
          lines.push(`  ${colors.green(j.version.padEnd(10))} ${j.path}`);
        }
        lines.push('');
        lines.push(colors.gray('Switch with: /java <path>'));
      }
      lines.push('');
      return lines.join('\n');
    }

    const cleanPath = newPath.trim().replace(/^['"]|['"]$/g, '');
    const info = checkJava(cleanPath);
    if (!info.installed) {
      return colors.failure(`No working Java found at "${cleanPath}".`);
    }
    this.configManager.updateSettings({ defaultJavaPath: cleanPath });
    return colors.success(`Java set to "${cleanPath}" (version ${info.version}). It will be used on the next /start.`);
  }

  /**
   * Executes /config
   */
  public executeConfig(): string {
    const cfg = this.configManager.getConfig();
    return '\n' + colors.bold(colors.cyan('Active Application Configuration:')) + '\n' + JSON.stringify(cfg, null, 2) + '\n';
  }

  /**
   * Executes /tunnel <java|bedrock> (and the legacy /tunnel create alias).
   *
   * Fully automated: ensures the binary + agent secret (claiming once if needed),
   * creates the tunnel, starts the agent, and returns the live connect address.
   */
  public async executeTunnelCreate(type: 'java' | 'bedrock'): Promise<string> {
    try {
      const firstRun = !this.playitManager.getSecret();
      if (firstRun) {
        console.log(colors.cyan('First-time setup: the playit agent must be claimed to your account once.'));
      } else {
        console.log(colors.cyan(`Creating ${type} tunnel...`));
      }

      const status = await this.playitManager.setupAndStart(type, {
        onClaimUrl: (url) => {
          const opened = openInBrowser(url);
          console.log(`\n🔗 ${colors.bold('One-time setup: approve the agent in your browser.')}`);
          if (opened) {
            console.log(colors.gray('Your browser was opened automatically — just sign in and click Approve.'));
          } else {
            console.log(colors.gray('Open this link, sign in (or create a free account), and click Approve:'));
          }
          console.log(colors.underline(colors.cyan(url)));
          console.log(colors.gray('Everything after this is automatic, and you will never be asked again.\n'));
        },
        onStatus: (msg) => console.log(colors.info(msg)),
      });

      return [
        colors.success(`${type === 'java' ? 'Java' : 'Bedrock'} tunnel is online!`),
        `\n🎮 Connect at: ${colors.bold(colors.green(`${status.address}:${status.port}`))}`,
        colors.gray('Share this address with players. The tunnel stays up while MCPANEL is running.'),
      ].join('\n');
    } catch (err: any) {
      if (err.message && err.message.includes('NotAllowedWithReadOnly')) {
        return colors.failure('The agent secret is read-only. Run /tunnel reset and try again to re-claim it.');
      }
      return colors.failure(`Failed to create tunnel: ${err.message}`);
    }
  }

  /**
   * Executes /tunnel reset — clears the saved secret so the agent can be re-claimed.
   */
  public async executeTunnelReset(): Promise<string> {
    await this.playitManager.resetSecret();
    return colors.success('Playit agent secret cleared. The next tunnel command will re-claim the agent.');
  }
}
