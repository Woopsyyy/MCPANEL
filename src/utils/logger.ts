import * as fs from 'fs';
import * as path from 'path';
import { APP_DATA_DIR } from '../config/configManager';

const LOGS_DIR = path.join(APP_DATA_DIR, 'logs');

function ensureLogsDirExists() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function writeLog(filename: string, message: string) {
  ensureLogsDirExists();
  const filePath = path.join(LOGS_DIR, filename);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(filePath, `[${timestamp}] ${message}\n`, 'utf-8');
}

export const logger = {
  info(message: string) {
    writeLog('mcpanel.log', `INFO: ${message}`);
  },
  
  error(message: string, error?: any) {
    const errorDetails = error ? ` - ${error.stack || error.message || error}` : '';
    writeLog('mcpanel.log', `ERROR: ${message}${errorDetails}`);
  },

  warn(message: string) {
    writeLog('mcpanel.log', `WARN: ${message}`);
  },

  logServerStart(serverName: string, message: string) {
    writeLog('server-start.log', `[${serverName}] ${message}`);
    writeLog('mcpanel.log', `SERVER START: [${serverName}] ${message}`);
  },

  logServerStop(serverName: string, message: string) {
    writeLog('server-stop.log', `[${serverName}] ${message}`);
    writeLog('mcpanel.log', `SERVER STOP: [${serverName}] ${message}`);
  },

  logTunnel(message: string) {
    writeLog('tunnel.log', message);
    writeLog('mcpanel.log', `TUNNEL: ${message}`);
  },

  getServerLogPath(serverName: string): string {
    ensureLogsDirExists();
    // Return path to the runtime console log for the server
    return path.join(LOGS_DIR, `server-${serverName.toLowerCase()}.log`);
  },

  writeServerConsoleLog(serverName: string, data: string) {
    ensureLogsDirExists();
    const filePath = path.join(LOGS_DIR, `server-${serverName.toLowerCase()}.log`);
    fs.appendFileSync(filePath, data, 'utf-8');
  }
};
