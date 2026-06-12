import { Cpu, MemoryStick, Users, Network, Server, Copy, Check, HardDrive, Activity, CircleCheck, TriangleAlert, CircleX } from 'lucide-react';
import { useState } from 'react';
import { Card, Pill, Skeleton, Chart, fmtUptime, fmtBytes } from '../components/ui';
import type { Overview, HealthItem, PlayerInfo } from '../lib/types';
import type { View } from '../components/Sidebar';

function StatCard({ icon, label, value, unit, children, accent }: {
  icon: React.ReactNode; label: string; value: string; unit?: string; children?: React.ReactNode; accent?: boolean;
}) {
  return (
    <Card className={`flex flex-col gap-3 p-4 transition-transform duration-200 hover:-translate-y-0.5 ${accent ? 'ring-1 ring-[var(--color-grass-deep)]/30' : ''}`}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-faint)]">
        {icon} {label}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular">{value}</span>
        {unit && <span className="text-sm text-[var(--color-text-soft)]">{unit}</span>}
      </div>
      {children}
    </Card>
  );
}

const healthIcon = { ok: CircleCheck, warn: TriangleAlert, danger: CircleX };
const healthColor = { ok: 'text-[var(--color-ok)]', warn: 'text-[var(--color-warn)]', danger: 'text-[var(--color-danger)]' };

function HealthPanel({ health }: { health: HealthItem[] }) {
  return (
    <Card className="p-4 sm:col-span-2 xl:col-span-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-faint)]">
        <Activity size={14} /> Health checks
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {health.map((h) => {
          const Icon = healthIcon[h.status];
          return (
            <div key={h.id} className="flex items-center gap-2.5 rounded-lg bg-[var(--color-surface-2)]/50 px-3 py-2.5">
              <Icon size={18} className={`${healthColor[h.status]} shrink-0`} />
              <div className="min-w-0">
                <div className="text-xs font-medium">{h.label}</div>
                <div className="truncate text-xs text-[var(--color-text-faint)]">{h.detail}</div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function OverviewView({ overview, players, onGoto, cpuHistory, ramHistory }: {
  overview: Overview | null; players: PlayerInfo[]; onGoto: (v: View) => void;
  cpuHistory: number[]; ramHistory: number[];
}) {
  const [copied, setCopied] = useState(false);

  if (!overview) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
      </div>
    );
  }

  const { process: proc, tunnel } = overview;
  const tunnelTone = tunnel.status === 'Online' ? 'ok' : tunnel.status === 'Connecting' ? 'warn' : 'neutral';
  const fullAddr = tunnel.address && tunnel.address !== 'None' ? `${tunnel.address}:${tunnel.port}` : null;

  const copyAddr = () => {
    if (!fullAddr) return;
    navigator.clipboard?.writeText(fullAddr).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard accent icon={<Server size={14} />} label="Server" value={overview.running ? 'Running' : 'Offline'}>
        <div className="text-xs text-[var(--color-text-soft)]">
          {overview.server ? `${overview.server.software} ${overview.server.version} · ${overview.server.ram} RAM` : 'No server'}
        </div>
        {proc
          ? <div className="text-xs text-[var(--color-text-faint)] tabular">Uptime {fmtUptime(Math.floor(proc.uptimeMs / 1000))} · PID {proc.pid}</div>
          : <div className="text-xs text-[var(--color-text-faint)]">Start the server to see live metrics</div>}
      </StatCard>

      <StatCard icon={<HardDrive size={14} />} label="Server size" value={fmtBytes(overview.serverDiskBytes).split(' ')[0]} unit={fmtBytes(overview.serverDiskBytes).split(' ')[1]}>
        <div className="text-xs text-[var(--color-text-faint)]">World + files on disk</div>
      </StatCard>

      <button onClick={() => onGoto('players')} className="text-left">
        <StatCard icon={<Users size={14} />} label="Players online" value={String(players.length)}>
          <div className="truncate text-xs text-[var(--color-text-soft)]">
            {players.length ? players.map((p) => p.name.replace(/^[.*_]/, '')).join(', ') : 'Nobody online right now'}
          </div>
        </StatCard>
      </button>

      {/* Tunnel — wide */}
      <Card className="flex flex-col justify-between gap-3 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-faint)]">
            <Network size={14} /> Tunnel
          </div>
          <Pill tone={tunnelTone}>{tunnel.status}</Pill>
        </div>
        {fullAddr ? (
          <div className="flex items-center gap-2">
            <code className="truncate rounded-md bg-[var(--color-surface-2)] px-2.5 py-1.5 font-mono text-xs text-[var(--color-grass)]">{fullAddr}</code>
            <button onClick={copyAddr} title="Copy address" className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-text-soft)] hover:text-[var(--color-text)]">
              {copied ? <Check size={15} className="text-[var(--color-ok)]" /> : <Copy size={15} />}
            </button>
          </div>
        ) : (
          <button onClick={() => onGoto('tunnels')} className="text-left text-xs text-[var(--color-text-faint)] hover:text-[var(--color-text-soft)]">No tunnel — set one up in Tunnels →</button>
        )}
        <div className="text-xs text-[var(--color-text-faint)] tabular">Latency {tunnel.latency}</div>
      </Card>

      {/* CPU chart — wide */}
      <Card className="flex flex-col gap-2 p-4 sm:col-span-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-faint)]">
            <Cpu size={14} /> Server CPU
          </div>
          <span className="text-sm font-bold tabular">{proc ? `${proc.cpu}%` : '—'}</span>
        </div>
        <Chart data={cpuHistory} max={100} unit="%" />
      </Card>

      {/* RAM chart — wide */}
      <Card className="flex flex-col gap-2 p-4 sm:col-span-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-faint)]">
            <MemoryStick size={14} /> Server RAM
          </div>
          <span className="text-sm font-bold tabular">{proc ? `${proc.ramMB} MB` : '—'}</span>
        </div>
        <Chart data={ramHistory} max={100} unit="%" color="var(--color-info)" />
      </Card>

      <HealthPanel health={overview.health} />
    </div>
  );
}
