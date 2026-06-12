import { ProcessManager } from '../services/processManager';

export type Platform = 'java' | 'bedrock';
export interface PlayerInfo {
  name: string;
  platform: Platform;
}

// Geyser/Floodgate prefixes Bedrock usernames (default '.') so they don't clash
// with Java accounts. A leading prefix char is our Bedrock signal.
const BEDROCK_PREFIXES = ['.', '*', '_'];

function platformOf(name: string): Platform {
  return BEDROCK_PREFIXES.includes(name[0]) ? 'bedrock' : 'java';
}

/**
 * Tracks who is currently on the Minecraft server by watching the live console
 * for join/leave lines, reconciling periodically against `list`. Records each
 * player's platform (Java vs Bedrock) and emits the roster whenever it changes.
 */
export class PlayerTracker {
  private players = new Map<string, Platform>();
  private unsubscribe: (() => void) | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private onChange: (players: PlayerInfo[]) => void;

  constructor(
    private processManager: ProcessManager,
    private serverName: string,
    onChange: (players: PlayerInfo[]) => void,
  ) {
    this.onChange = onChange;
  }

  public start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.processManager.subscribeConsole(this.serverName, (data) => this.ingest(data));
    // Self-healing reconcile; kept infrequent so it barely shows in the console.
    this.reconcileTimer = setInterval(() => this.prime(), 30000);
    setTimeout(() => this.prime(), 1500);
  }

  public stop(): void {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
    this.players.clear();
  }

  /** Asks the server for the authoritative roster (also used right after start). */
  public prime(): void {
    this.processManager.sendCommand(this.serverName, 'list');
  }

  public getPlayers(): PlayerInfo[] {
    return Array.from(this.players.entries())
      .map(([name, platform]) => ({ name, platform }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Parses a console chunk for join/leave and `list` output. */
  private ingest(chunk: string): void {
    let changed = false;
    for (const line of chunk.split(/\r?\n/)) {
      // "PlayerName joined the game" — name may carry a Bedrock prefix like ".Name".
      const join = line.match(/:\s*([.*_]?[A-Za-z0-9_]{1,16}) joined the game/);
      if (join) {
        const name = join[1];
        if (this.players.get(name) === undefined) { this.players.set(name, platformOf(name)); changed = true; }
        continue;
      }

      const leave = line.match(/:\s*([.*_]?[A-Za-z0-9_]{1,16}) left the game/);
      if (leave) { if (this.players.delete(leave[1])) changed = true; continue; }

      // "There are 2 of a max of 20 players online: Alice, .Bob"
      const list = line.match(/players online:\s*(.*)$/i);
      if (list) {
        const names = list[1].split(',').map((n) => n.trim()).filter((n) => /^[.*_]?[A-Za-z0-9_]{1,16}$/.test(n));
        const next = new Map<string, Platform>(names.map((n) => [n, platformOf(n)]));
        if (next.size !== this.players.size || names.some((n) => !this.players.has(n))) {
          this.players = next;
          changed = true;
        }
      }
    }
    if (changed) this.onChange(this.getPlayers());
  }
}
