import SysTray, { Conf } from 'systray2';
import * as path from 'path';
import * as fs from 'fs';
import { detectOS, getActiveWindowHandle, hideConsoleWindow, showConsoleWindow } from '../utils/helpers';
import { APP_ROOT, ConfigManager } from '../config/configManager';
import { ProcessManager } from '../services/processManager';
import { PlayitManager } from '../managers/playitManager';
import { logger } from '../utils/logger';
import * as colors from '../utils/colors';

const SysTrayBase = SysTray as any;

class WSLSysTray extends SysTrayBase {
  constructor(conf: Conf) {
    super(conf);
  }

  async init(): Promise<void> {
    const osType = detectOS();
    if (osType === 'WSL') {
      const binName = "tray_windows_release.exe";
      const nodeModulesBin = path.join(APP_ROOT, 'node_modules', 'systray2', 'traybin', binName);
      (this as any)._binPath = nodeModulesBin;
      
      // Auto chmod +x to ensure the binary is executable from WSL
      try {
        fs.chmodSync(nodeModulesBin, 0o755);
      } catch { /* ignore */ }

      return new Promise<void>(async (resolve, reject) => {
        try {
          const child = require('child_process');
          const readline = require('readline');
          
          (this as any)._process = child.spawn((this as any)._binPath, [], {
            windowsHide: true
          });
          (this as any)._process.on('error', reject);
          (this as any)._rl = readline.createInterface({
            input: (this as any)._process.stdout
          });
          
          const internalIdMap = (this as any).internalIdMap;
          const counter = { id: 1 };
          
          const addInternalId = (item: any) => {
            const id = counter.id++;
            internalIdMap.set(id, item);
            if (item.items) {
              item.items.forEach(addInternalId);
            }
            item.__id = id;
          };
          (this as any)._conf.menu.items.forEach(addInternalId);
          
          const loadIcon = async (fileName: string) => {
            const buffer = await fs.promises.readFile(fileName);
            return buffer.toString('base64');
          };
          
          const resolveIcon = async (item: any) => {
            if (item.icon && fs.existsSync(item.icon)) {
              item.icon = await loadIcon(item.icon);
            }
            if (item.items) {
              await Promise.all(item.items.map((sub: any) => resolveIcon(sub)));
            }
          };
          await resolveIcon((this as any)._conf.menu);
          
          (this as any).onReady(() => {
            const itemTrimmer = (item: any) => ({
              title: item.title,
              tooltip: item.tooltip,
              checked: item.checked,
              enabled: item.enabled === undefined ? true : item.enabled,
              hidden: item.hidden,
              items: item.items,
              icon: item.icon,
              isTemplateIcon: item.isTemplateIcon,
              __id: item.__id
            });
            const menuTrimmer = (menu: any) => ({
              icon: menu.icon,
              title: menu.title,
              tooltip: menu.tooltip,
              items: menu.items.map(itemTrimmer),
              isTemplateIcon: menu.isTemplateIcon
            });
            
            (this as any).writeLine(JSON.stringify(menuTrimmer((this as any)._conf.menu)));
            resolve();
          });
        } catch (err) {
          reject(err);
        }
      });
    } else {
      return super.init();
    }
  }
}

export class TrayManager {
  private systray: SysTray | null = null;
  private activeHandle: string | null = null;
  private isInitialized = false;
  // The tray runs a separate native helper over a stdin pipe. If that helper
  // dies, writes to its pipe raise an async EPIPE. The tray is best-effort, so
  // this flag lets us stop writing and degrade to CLI-only instead of crashing.
  private trayAlive = false;

  // Menu item state tracking
  private itemShow = { title: 'Open Console', tooltip: 'Restore terminal window', enabled: true };
  private itemHide = { title: 'Hide Console', tooltip: 'Hide terminal window from taskbar', enabled: true };
  private itemServerStatus = { title: 'Server: Checking...', tooltip: 'Current Minecraft server status', enabled: false };
  private itemServerToggle = { title: 'Start Server', tooltip: 'Toggle server state', enabled: true };
  private itemTunnelStatus = { title: 'Tunnel: Checking...', tooltip: 'Current Playit tunnel status', enabled: false };
  private itemTunnelToggle = { title: 'Start Tunnel', tooltip: 'Toggle tunnel state', enabled: true };
  private itemExit = { title: 'Exit', tooltip: 'Stop server/tunnel and exit', enabled: true };

  constructor(
    private configManager: ConfigManager,
    private processManager: ProcessManager,
    private playitManager: PlayitManager
  ) {}

  /**
   * Initializes and starts the system tray icon loop
   */
  public async start(): Promise<boolean> {
    if (this.isInitialized) return true;

    const osType = detectOS();
    const iconCandidate = osType === 'Windows' || osType === 'WSL'
      ? path.join(APP_ROOT, 'assets', 'logo.ico')
      : path.join(APP_ROOT, 'assets', 'logo.png');
    // systray2 only base64-encodes the icon if the file exists; otherwise it
    // ships the raw path, which the native helper can't decode and then exits.
    // Omit a missing icon so the helper stays alive (CLI works without one).
    const iconFile = fs.existsSync(iconCandidate) ? iconCandidate : undefined;
    if (!iconFile) {
      logger.warn(`Tray icon not found at ${iconCandidate}; starting tray without an icon.`);
    }

    try {
      this.systray = new WSLSysTray({
        menu: {
          // May be undefined when the icon file is absent; systray2 tolerates
          // this at runtime (it pathExists-checks before encoding) — the cast
          // just satisfies the `Conf` type, which declares icon as required.
          icon: iconFile as string,
          title: 'MCPANEL',
          tooltip: 'MCPANEL Server Manager',
          items: [
            this.itemShow,
            this.itemHide,
            SysTray.separator,
            this.itemServerStatus,
            this.itemServerToggle,
            SysTray.separator,
            this.itemTunnelStatus,
            this.itemTunnelToggle,
            SysTray.separator,
            this.itemExit
          ]
        },
        debug: false
      }) as unknown as SysTray;

      this.systray.onClick((event: any) => {
        this.handleTrayClick(event).catch((err) => {
          logger.error('Error handling tray click event', err);
        });
      });

      await this.systray.ready();
      this.isInitialized = true;
      this.trayAlive = true;
      this.attachTrayGuards();
      logger.info('System tray initialized successfully.');
      this.updateMenu();
      return true;
    } catch (err: any) {
      this.systray = null;
      logger.error('Failed to initialize system tray', err);
      // Fail silently for user prompt, fall back to CLI-only mode gracefully.
      return false;
    }
  }

  /**
   * Attaches error/exit listeners to the native tray helper so a dead helper
   * (e.g. EPIPE when writing to its closed stdin) degrades to CLI-only mode
   * instead of throwing an unhandled 'error' event that crashes the process.
   */
  private attachTrayGuards(): void {
    const proc: any = (this.systray as any)?._process;
    if (!proc) return;
    const onDead = (err?: any) => {
      if (this.trayAlive) {
        const detail = err ? ` (${err.code || err.message})` : '';
        logger.warn(`System tray helper stopped; continuing in CLI-only mode.${detail}`);
      }
      this.trayAlive = false;
    };
    // The load-bearing handler: without an 'error' listener, an EPIPE on the
    // helper's stdin is emitted as an unhandled 'error' event and crashes Node.
    proc.stdin?.on('error', onDead);
    proc.on('error', onDead);
    proc.on('exit', () => onDead());
    proc.on('close', () => onDead());
  }

  /**
   * Dynamically updates the titles and states of the tray menu items
   */
  public updateMenu() {
    const tray = this.systray;
    if (!tray || !this.isInitialized || !this.trayAlive) return;

    const server = this.configManager.getServer();
    const running = server ? !!this.processManager.getActiveServer(server.name) : false;
    const tunnel = this.playitManager.getStatus();

    // Update server status & toggle label
    this.itemServerStatus.title = `Server: ${running ? 'Running' : 'Offline'}`;
    this.itemServerToggle.title = running ? 'Stop Server' : 'Start Server';
    this.itemServerToggle.enabled = !!server;

    // Update tunnel status & toggle label
    this.itemTunnelStatus.title = `Tunnel: ${tunnel.status}`;
    this.itemTunnelToggle.title = tunnel.status === 'Online' || tunnel.status === 'Connecting' ? 'Stop Tunnel' : 'Start Tunnel';

    // Push updates to the native helper
    tray.sendAction({ type: 'update-item', item: this.itemServerStatus });
    tray.sendAction({ type: 'update-item', item: this.itemServerToggle });
    tray.sendAction({ type: 'update-item', item: this.itemTunnelStatus });
    tray.sendAction({ type: 'update-item', item: this.itemTunnelToggle });
  }

  /**
   * Hides the active terminal window to the background
   */
  public hideConsole(): boolean {
    const handle = getActiveWindowHandle();
    if (!handle) {
      logger.warn('Could not retrieve active console window handle.');
      return false;
    }
    this.activeHandle = handle;
    const success = hideConsoleWindow(handle);
    if (success) {
      logger.info(`Console window (${handle}) hidden to background.`);
    }
    return success;
  }

  /**
   * Restores the hidden console window back to foreground
   */
  public showConsole(): boolean {
    const handle = this.activeHandle;
    if (!handle) {
      logger.warn('No saved console window handle to restore.');
      // Fallback: try to retrieve current active handle (best effort if not saved)
      const curHandle = getActiveWindowHandle();
      if (curHandle) {
        return showConsoleWindow(curHandle);
      }
      return false;
    }
    const success = showConsoleWindow(handle);
    if (success) {
      logger.info(`Console window (${handle}) restored to foreground.`);
    }
    return success;
  }

  /**
   * Handles individual tray menu click actions
   */
  private async handleTrayClick(event: any): Promise<void> {
    const title = event.item.title;

    if (title === 'Open Console') {
      this.showConsole();
    } else if (title === 'Hide Console') {
      this.hideConsole();
    } else if (title === 'Start Server') {
      const server = this.configManager.getServer();
      if (!server) return;

      const jarPath = path.join(server.path, 'server.jar');
      let resolvedJar = jarPath;
      if (!fs.existsSync(jarPath)) {
        const jarFiles = fs.readdirSync(server.path).filter(f => f.endsWith('.jar'));
        if (jarFiles.length > 0) {
          resolvedJar = path.join(server.path, jarFiles[0]);
        }
      }

      try {
        logger.info(`Starting Minecraft server "${server.name}" from tray menu...`);
        await this.processManager.startServer(
          server.name,
          server.path,
          resolvedJar,
          server.ram,
          this.configManager.getConfig().defaultJavaPath
        );
      } catch (err: any) {
        logger.error('Failed to start server from tray', err);
      }
      this.updateMenu();
    } else if (title === 'Stop Server') {
      const server = this.configManager.getServer();
      if (!server) return;
      logger.info(`Stopping Minecraft server "${server.name}" from tray menu gracefully...`);
      await this.processManager.stopServer(server.name);
      this.updateMenu();
    } else if (title === 'Start Tunnel') {
      logger.info('Starting playit tunnel agent from tray menu...');
      try {
        const savedSettings = this.configManager.getConfig().playitSettings;
        const type = (savedSettings.tunnelAddress ? 'java' : 'java'); // default to java
        await this.playitManager.setupAndStart(type);
      } catch (err: any) {
        logger.error('Failed to start tunnel from tray', err);
      }
      this.updateMenu();
    } else if (title === 'Stop Tunnel') {
      logger.info('Stopping playit tunnel agent from tray menu...');
      this.playitManager.stopTunnel();
      this.updateMenu();
    } else if (title === 'Exit') {
      logger.info('Exit requested from system tray. Shutting down MCPANEL...');
      
      // Stop server
      const server = this.configManager.getServer();
      if (server) {
        await this.processManager.stopServer(server.name);
      }

      // Stop tunnel
      this.playitManager.stopTunnel();

      // Clean exit
      const tray = this.systray;
      if (tray) {
        await tray.kill(true);
      } else {
        process.exit(0);
      }
    }
  }
}
