// The token is baked into the URL the CLI opened (?token=…). Every API call and
// the WebSocket handshake must carry it, or the server returns 401.
export const TOKEN = new URLSearchParams(window.location.search).get('token') || '';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  // Only declare a JSON content-type when we actually send a body — a POST with
  // `application/json` and an empty body makes Fastify reply 400.
  const headers: Record<string, string> = { 'x-mcpanel-token': TOKEN, ...(init?.headers as Record<string, string> || {}) };
  if (init?.body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}${sep}token=${encodeURIComponent(TOKEN)}`, { ...init, headers });
  if (!res.ok) {
    // Surface the server's error message when it sends one.
    let detail = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j?.error) detail = j.error; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  overview: () => req<import('./types').Overview>('/overview'),
  players: () => req<{ players: import('./types').PlayerInfo[] }>('/players'),
  content: () => req<import('./types').ContentListing>('/content'),
  tunnels: () => req<{ tunnels: import('./types').Tunnel[]; status: any }>('/tunnels'),
  backups: () => req<{ backups: import('./types').Backup[] }>('/backups'),

  serverStart: () => req<{ message: string }>('/server/start', { method: 'POST' }),
  serverStop: () => req<{ message: string }>('/server/stop', { method: 'POST' }),
  serverRestart: () => req<{ message: string }>('/server/restart', { method: 'POST' }),

  backupCreate: () => req<{ message: string }>('/backups', { method: 'POST' }),
  backupRestore: (id: string) => req<{ message: string }>(`/backups/${encodeURIComponent(id)}/restore`, { method: 'POST' }),

  // Phase 2
  contentDelete: (file: string) => req<{ message: string }>(`/content/${encodeURIComponent(file)}`, { method: 'DELETE' }),
  scheduleGet: () => req<import('./types').ScheduleState>('/backups/schedule'),
  schedulePut: (enabled: boolean, intervalHours: number, maxBackups?: number) =>
    req<import('./types').ScheduleState>('/backups/schedule', { method: 'PUT', body: JSON.stringify({ enabled, intervalHours, maxBackups }) }),
  tunnelCreate: (type: 'java' | 'bedrock') =>
    req<{ message: string }>('/tunnels/create', { method: 'POST', body: JSON.stringify({ type }) }),
  tunnelStop: () => req<{ message: string }>('/tunnels/stop', { method: 'POST' }),

  // Phase 3
  settingsGet: () => req<import('./types').Settings>('/settings'),
  settingsPut: (patch: Partial<import('./types').Settings>) =>
    req<{ message: string; settings: import('./types').Settings }>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  ramPut: (gb: number) => req<{ message: string; ram: string }>('/server/ram', { method: 'PUT', body: JSON.stringify({ gb }) }),

  playitStatus: () => req<import('./types').PlayitStatus>('/playit/status'),
  playitConnect: () => req<{ message: string; linked: boolean; tunnels: import('./types').Tunnel[] }>('/playit/connect', { method: 'POST' }),
  playitOnline: () => req<{ message: string }>('/playit/online', { method: 'POST' }),

  maintenanceGet: () => req<import('./types').MaintenanceInfo>('/maintenance'),
  maintenanceSyncServer: (path: string) => req<{ message: string }>('/maintenance/sync-server', { method: 'POST', body: JSON.stringify({ path }) }),
  maintenanceBackupLocation: (path: string) => req<{ message: string; backupLocation: string }>('/maintenance/backup-location', { method: 'PUT', body: JSON.stringify({ path }) }),
  installGeyser: () => req<{ message: string; installed: string[] }>('/maintenance/install-geyser', { method: 'POST' }),

  // Multipart upload bypasses the JSON helper so the browser sets the boundary.
  async contentUpload(files: File[]): Promise<{ message: string; saved: string[]; rejected: string[] }> {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    const res = await fetch(`/api/content/upload?token=${encodeURIComponent(TOKEN)}`, {
      method: 'POST', headers: { 'x-mcpanel-token': TOKEN }, body: form,
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try { const j = await res.json(); if (j?.error) detail = j.error; } catch { /* keep */ }
      throw new Error(detail);
    }
    return res.json();
  },
};

export function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws?token=${encodeURIComponent(TOKEN)}`;
}
