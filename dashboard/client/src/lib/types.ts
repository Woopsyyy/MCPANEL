export interface HealthItem {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'danger';
  detail: string;
}

export type Platform = 'java' | 'bedrock';
export interface PlayerInfo {
  name: string;
  platform: Platform;
}

export interface Overview {
  server: { name: string; displayName: string; path: string; software: string; version: string; ram: string } | null;
  system: { cpuUsage: number; usedMemGB: number; totalMemGB: number; memUsagePct: number; uptimeSeconds: number };
  tunnel: { status: 'Offline' | 'Connecting' | 'Online'; address: string; port: string; latency: string; type: string | null };
  players: PlayerInfo[];
  running: boolean;
  process: { pid: number; cpu: string; ramMB: string; uptimeMs: number } | null;
  serverDiskBytes: number;
  health: HealthItem[];
}

export interface Settings {
  displayName: string;
  name: string;
  motd: string;
  maxPlayers: string;
  difficulty: string;
  gamemode: string;
  pvp: boolean;
  onlineMode: boolean;
  whitelist: boolean;
  enforceWhitelist: boolean;
  ram: string;
  ramGB: number;
  totalMemGB: number;
  recommended: { minGB: number; maxGB: number };
  contentCount: number;
  maxPlayersNum: number;
}

export interface PlayitStatus {
  linked: boolean;
  relayRunning: boolean;
  tunnels: Tunnel[];
}

export interface MaintenanceInfo {
  serverPath: string | null;
  serverName: string | null;
  backupLocation: string;
}

export interface ContentItem {
  file: string;
  name: string;
  version: string;
  sizeBytes: number;
}

export interface ContentListing {
  kind: 'mods' | 'plugins';
  dir: string;
  exists: boolean;
  items: ContentItem[];
}

export interface Tunnel {
  id: string;
  name: string;
  proto: string;
  address: string;
  port: string;
  active: boolean;
}

export interface Backup {
  id: string;
  serverName: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ScheduleState {
  enabled: boolean;
  intervalHours: number;
  maxBackups: number;
  nextRunMs: number | null;
  lastRunMs: number | null;
  lastResult: string | null;
}

export type WsMessage =
  | { type: 'status'; data: Overview }
  | { type: 'console'; data: string }
  | { type: 'playit'; data: string }
  | { type: 'players'; data: PlayerInfo[] }
  | { type: 'notice'; data: string }
  | { type: 'console-clear' };
