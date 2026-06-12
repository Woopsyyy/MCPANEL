import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import { checkJava } from '../utils/helpers';

export type ServerStatus = 'Offline' | 'Starting' | 'Running';

export interface ActiveServer {
  name: string;
  process: ChildProcess;
  status: ServerStatus;
  startTime: number;
  pid: number;
}

export class ProcessManager {
  private activeServers: Map<string, ActiveServer> = new Map();
  private consoleCallbacks: Map<string, (data: string) => void> = new Map();
  // Fan-out subscribers (e.g. the web dashboard) that receive the same console
  // output as the terminal view, independently and without replacing each other.
  private consoleSubscribers: Map<string, Set<(data: string) => void>> = new Map();
  // Listeners notified whenever a server starts running or stops, so the CLI
  // status line and the dashboard can update in realtime.
  private stateListeners: Set<() => void> = new Set();

  /** Subscribes to start/stop state changes. Returns an unsubscribe function. */
  public onStateChange(cb: () => void): () => void {
    this.stateListeners.add(cb);
    return () => { this.stateListeners.delete(cb); };
  }

  private notifyState(): void {
    for (const cb of this.stateListeners) {
      try { cb(); } catch { /* a broken listener must not break process handling */ }
    }
  }

  /**
   * Starts a server process.
   */
  public startServer(
    name: string,
    serverDir: string,
    jarPath: string,
    ram: string,
    javaPath = 'java'
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const key = name.toLowerCase();
      if (this.activeServers.has(key)) {
        reject(new Error(`Server "${name}" is already running.`));
        return;
      }

      // Check if Java is installed
      const javaCheck = checkJava(javaPath);
      if (!javaCheck.installed) {
        reject(new Error(`Java was not found at "${javaPath}". Please ensure Java is installed.`));
        return;
      }

      if (!fs.existsSync(jarPath)) {
        reject(new Error(`Server jar was not found at "${jarPath}".`));
        return;
      }

      logger.logServerStart(name, `Launching Java process in ${serverDir} with ${ram} RAM`);

      // Prepare JVM arguments. Ensure RAM syntax (e.g. 4G -> -Xmx4G)
      const cleanedRam = ram.replace(/[^0-9a-zA-Z]/g, '');
      const args = [
        `-Xmx${cleanedRam}`,
        `-Xms${cleanedRam}`,
        '-jar',
        jarPath,
        'nogui'
      ];

      // Spawn process inside the server directory
      const child = spawn(javaPath, args, {
        cwd: serverDir,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const serverInfo: ActiveServer = {
        name,
        process: child,
        status: 'Starting',
        startTime: Date.now(),
        pid: child.pid || 0,
      };

      this.activeServers.set(key, serverInfo);
      this.notifyState(); // server is now spawning — update CLI + dashboard immediately

      // Clean/reset console log on start
      const logFilePath = logger.getServerLogPath(name);
      try {
        if (fs.existsSync(logFilePath)) {
          fs.writeFileSync(logFilePath, '', 'utf-8');
        }
      } catch (err) {
        logger.error(`Failed to clear console log for ${name}`, err);
      }

      // Handle stdout
      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        logger.writeServerConsoleLog(name, chunk);
        
        // Check for startup completion keywords
        if (serverInfo.status === 'Starting') {
          if (
            chunk.includes('Done (') || 
            chunk.includes('For help, type "help"') || 
            chunk.includes('Starting velocity server') || // velocity starts quickly
            chunk.includes('Ready for connections')
          ) {
            serverInfo.status = 'Running';
            logger.logServerStart(name, `Server fully loaded (PID: ${child.pid})`);
            this.notifyState();
          }
        }

        // Forward to console streaming callbacks
        const callback = this.consoleCallbacks.get(key);
        if (callback) {
          callback(chunk);
        }
        this.emitToSubscribers(key, chunk);
      });

      // Handle stderr
      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        logger.writeServerConsoleLog(name, `[STDERR] ${chunk}`);

        const callback = this.consoleCallbacks.get(key);
        if (callback) {
          callback(`[STDERR] ${chunk}`);
        }
        this.emitToSubscribers(key, `[STDERR] ${chunk}`);
      });

      // Handle process exit
      child.on('close', (code) => {
        logger.logServerStop(name, `Process exited with code ${code}`);
        this.activeServers.delete(key);
        this.consoleCallbacks.delete(key);
        this.notifyState();
      });

      child.on('error', (err) => {
        logger.error(`Process error for server "${name}"`, err);
        reject(err);
      });

      // Wait a moment to ensure it spawns without immediate crash
      setTimeout(() => {
        if (child.pid) {
          resolve();
        } else {
          reject(new Error('Process failed to spawn'));
        }
      }, 500);
    });
  }

  /**
   * Stops a server process gracefully, falling back to SIGKILL.
   */
  public async stopServer(name: string): Promise<boolean> {
    const key = name.toLowerCase();
    const server = this.activeServers.get(key);
    if (!server) {
      return false;
    }

    logger.logServerStop(name, 'Graceful shutdown initiated.');
    server.status = 'Offline'; // Update state immediately

    return new Promise((resolve) => {
      // Send "stop" command to standard input
      try {
        if (server.process.stdin) {
          server.process.stdin.write('stop\n');
        } else {
          logger.error(`Cannot stop server ${name}: stdin is not available.`);
        }
      } catch (err) {
        logger.error(`Failed to write stop command to stdin of ${name}`, err);
      }

      // Check if process has exited within 15 seconds, otherwise kill it
      const timeout = setTimeout(() => {
        if (this.activeServers.has(key)) {
          logger.warn(`Server ${name} did not stop gracefully. Force killing process (PID: ${server.pid})`);
          try {
            server.process.kill('SIGKILL');
          } catch (err) {
            logger.error(`Error killing server ${name} process`, err);
          }
        }
        resolve(true);
      }, 15000);

      // Listen for process exit to resolve immediately
      server.process.on('exit', () => {
        clearTimeout(timeout);
        this.activeServers.delete(key);
        resolve(true);
      });
    });
  }

  /**
   * Sends terminal command input to a running server console.
   */
  public sendCommand(name: string, command: string): boolean {
    const key = name.toLowerCase();
    const server = this.activeServers.get(key);
    if (!server) {
      return false;
    }

    try {
      if (server.process.stdin) {
        server.process.stdin.write(command + '\n');
        return true;
      } else {
        logger.error(`Failed to send command to ${name}: stdin is null.`);
        return false;
      }
    } catch (err) {
      logger.error(`Failed to send command to ${name}: ${command}`, err);
      return false;
    }
  }

  /**
   * Registers a console logging callback for active log streaming.
   */
  public registerConsoleStream(name: string, callback: (data: string) => void): void {
    this.consoleCallbacks.set(name.toLowerCase(), callback);
  }

  /**
   * Unregisters console logging callback.
   */
  public unregisterConsoleStream(name: string): void {
    this.consoleCallbacks.delete(name.toLowerCase());
  }

  /**
   * Subscribes a fan-out consumer (e.g. the web dashboard) to a server's live
   * console output. Unlike registerConsoleStream this supports many independent
   * subscribers and does not replace the terminal's own console view. Returns an
   * unsubscribe function.
   */
  public subscribeConsole(name: string, callback: (data: string) => void): () => void {
    const key = name.toLowerCase();
    let set = this.consoleSubscribers.get(key);
    if (!set) {
      set = new Set();
      this.consoleSubscribers.set(key, set);
    }
    set.add(callback);
    return () => {
      const current = this.consoleSubscribers.get(key);
      if (current) {
        current.delete(callback);
        if (current.size === 0) this.consoleSubscribers.delete(key);
      }
    };
  }

  /** Pushes a console chunk to every fan-out subscriber for a server. */
  private emitToSubscribers(key: string, chunk: string): void {
    const set = this.consoleSubscribers.get(key);
    if (!set) return;
    for (const cb of set) {
      try { cb(chunk); } catch { /* a broken subscriber must not break the stream */ }
    }
  }

  /**
   * Returns list of running server PIDs and states.
   */
  public getActiveServers(): Map<string, ActiveServer> {
    return this.activeServers;
  }

  /**
   * Gets details for a specific active server.
   */
  public getActiveServer(name: string): ActiveServer | undefined {
    return this.activeServers.get(name.toLowerCase());
  }
}
