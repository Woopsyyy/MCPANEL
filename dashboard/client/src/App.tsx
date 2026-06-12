import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Square, RotateCw, Wifi, WifiOff, Circle } from 'lucide-react';
import { Sidebar, type View } from './components/Sidebar';
import { Pill, Button } from './components/ui';
import { useSocket } from './lib/useSocket';
import { api } from './lib/api';
import type { Overview, WsMessage, PlayerInfo } from './lib/types';
import { OverviewView } from './views/Overview';
import { PlayersView } from './views/Players';
import { ContentView } from './views/Content';
import { TunnelsView } from './views/Tunnels';
import { ConsoleView } from './views/Console';
import { BackupsView } from './views/Backups';
import { SettingsView } from './views/Settings';
import { MaintenanceView } from './views/Maintenance';

const CONSOLE_CAP = 60000;

export default function App() {
  const [view, setView] = useState<View>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [players, setPlayers] = useState<PlayerInfo[]>([]);
  const [consoleText, setConsoleText] = useState('');
  const [playitText, setPlayitText] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contentCount, setContentCount] = useState(0);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [ramHistory, setRamHistory] = useState<number[]>([]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }, []);

  const onMessage = useCallback((msg: WsMessage) => {
    switch (msg.type) {
      case 'status': {
        setOverview(msg.data);
        setPlayers(msg.data.players);
        // Track the SERVER process: CPU%, and RAM as a % of host memory.
        const cpu = msg.data.process ? parseFloat(msg.data.process.cpu) || 0 : 0;
        const totalMB = (msg.data.system.totalMemGB || 1) * 1024;
        const ram = msg.data.process ? Math.min(100, (parseFloat(msg.data.process.ramMB) / totalMB) * 100) : 0;
        setCpuHistory((h) => [...h, cpu].slice(-40));
        setRamHistory((h) => [...h, ram].slice(-40));
        break;
      }
      case 'console-clear':
        setConsoleText('');
        break;
      case 'players':
        setPlayers(msg.data);
        break;
      case 'console':
        setConsoleText((t) => (t + msg.data).slice(-CONSOLE_CAP));
        break;
      case 'playit':
        setPlayitText((t) => (t + msg.data).slice(-CONSOLE_CAP));
        break;
      case 'notice':
        showToast(msg.data);
        break;
    }
  }, [showToast]);

  const { connected, send } = useSocket(onMessage);

  // Initial REST snapshot so panels paint before the first WS tick.
  useEffect(() => {
    api.overview().then((o) => { setOverview(o); setPlayers(o.players); }).catch(() => { /* WS will fill in */ });
    api.content().then((c) => setContentCount(c.items.length)).catch(() => { /* ignore */ });
  }, []);

  const runAction = async (label: string, fn: () => Promise<{ message: string }>) => {
    setBusy(true);
    try {
      const { message } = await fn();
      showToast(message);
    } catch (e: any) {
      showToast(`${label} failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const running = overview?.running ?? false;
  const serverName = overview?.server?.displayName ?? overview?.server?.name ?? '—';

  return (
    <div className="flex h-full">
      <Sidebar active={view} onSelect={setView} badgeCtx={{ players: players.length, content: contentCount }} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex items-center justify-between gap-4 border-b border-[var(--color-border-soft)] bg-[var(--color-surface-1)] px-4 py-3 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-base font-semibold">{serverName}</span>
                {overview?.server && (
                  <span className="hidden text-xs text-[var(--color-text-faint)] sm:inline">
                    {overview.server.software} {overview.server.version}
                  </span>
                )}
              </div>
            </div>
            <Pill tone={running ? 'ok' : 'neutral'}>
              <Circle size={8} className={running ? 'fill-current' : ''} />
              {running ? 'Running' : 'Offline'}
            </Pill>
          </div>

          <div className="flex items-center gap-2">
            <span title={connected ? 'Live' : 'Reconnecting…'} className="mr-1 hidden sm:block">
              {connected
                ? <Wifi size={16} className="text-[var(--color-ok)]" />
                : <WifiOff size={16} className="text-[var(--color-warn)]" />}
            </span>
            {running ? (
              <>
                <Button tone="danger" disabled={busy} onClick={() => runAction('Stop', api.serverStop)} title="Stop server">
                  <Square size={16} /> <span className="hidden sm:inline">Stop</span>
                </Button>
                <Button disabled={busy} onClick={() => runAction('Restart', api.serverRestart)} title="Restart server">
                  <RotateCw size={16} /> <span className="hidden sm:inline">Restart</span>
                </Button>
              </>
            ) : (
              <Button tone="primary" disabled={busy} onClick={() => runAction('Start', api.serverStart)} title="Start server">
                <Play size={16} /> <span className="hidden sm:inline">Start</span>
              </Button>
            )}
          </div>
        </header>

        {!connected && (
          <div className="bg-amber-400/10 px-4 py-1.5 text-center text-xs text-[var(--color-warn)]">
            Connection lost — reconnecting to MCPANEL…
          </div>
        )}

        {/* View body */}
        <main className="min-h-0 flex-1 overflow-y-auto scroll-thin p-4 md:p-6">
          <div key={view} className="animate-in">
          {view === 'overview' && <OverviewView overview={overview} players={players} onGoto={setView} cpuHistory={cpuHistory} ramHistory={ramHistory} />}
          {view === 'players' && <PlayersView players={players} running={running} />}
          {view === 'content' && <ContentView onCount={setContentCount} showToast={showToast} />}
          {view === 'tunnels' && <TunnelsView showToast={showToast} />}
          {view === 'console' && (
            <ConsoleView text={consoleText} playitText={playitText} running={running} onSend={(cmd) => send({ type: 'command', command: cmd })} />
          )}
          {view === 'backups' && <BackupsView showToast={showToast} />}
          {view === 'settings' && <SettingsView showToast={showToast} />}
          {view === 'maintenance' && <MaintenanceView showToast={showToast} />}
          </div>
        </main>
      </div>

      {toast && (
        <div className="toast-in fixed bottom-5 left-1/2 z-50 max-w-lg -translate-x-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-sm shadow-xl" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}
