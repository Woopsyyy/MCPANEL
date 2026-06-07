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
          }
        }

        // Forward to console streaming callbacks
        const callback = this.consoleCallbacks.get(key);
        if (callback) {
          callback(chunk);
        }
      });

      // Handle stderr
      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        logger.writeServerConsoleLog(name, `[STDERR] ${chunk}`);
        
        const callback = this.consoleCallbacks.get(key);
        if (callback) {
          callback(`[STDERR] ${chunk}`);
        }
      });

      // Handle process exit
      child.on('close', (code) => {
        logger.logServerStop(name, `Process exited with code ${code}`);
        this.activeServers.delete(key);
        this.consoleCallbacks.delete(key);
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
