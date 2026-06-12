import { useEffect, useState } from 'react';
import { Network, RefreshCw, Copy, Check, Plus, Power, Loader2, Link2, Radio } from 'lucide-react';
import { Card, CardHeader, EmptyState, Skeleton, Pill, Button } from '../components/ui';
import { api } from '../lib/api';
import type { Tunnel, PlayitStatus } from '../lib/types';

export function TunnelsView({ showToast }: { showToast: (m: string) => void }) {
  const [tunnels, setTunnels] = useState<Tunnel[] | null>(null);
  const [status, setStatus] = useState<PlayitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.playitStatus()
      .then((st) => { setStatus(st); setTunnels(st.tunnels); })
      .catch(() => { setStatus(null); setTunnels([]); })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const connect = async () => {
    setBusy('connect');
    try { showToast((await api.playitConnect()).message); load(); }
    catch (e: any) { showToast(`Connect failed: ${e.message}`); }
    finally { setBusy(null); }
  };

  const goOnline = async () => {
    setBusy('online');
    try { showToast((await api.playitOnline()).message); load(); }
    catch (e: any) { showToast(`Go online failed: ${e.message}`); }
    finally { setBusy(null); }
  };

  const create = async (type: 'java' | 'bedrock') => {
    setBusy(type);
    try { showToast((await api.tunnelCreate(type)).message); load(); }
    catch (e: any) { showToast(`Tunnel failed: ${e.message}`); }
    finally { setBusy(null); }
  };

  const stop = async () => {
    setBusy('stop');
    try { showToast((await api.tunnelStop()).message); load(); }
    catch (e: any) { showToast(`Stop failed: ${e.message}`); }
    finally { setBusy(null); }
  };

  const copy = (addr: string) => {
    navigator.clipboard?.writeText(addr).then(() => {
      setCopied(addr);
      window.setTimeout(() => setCopied((c) => (c === addr ? null : c)), 1500);
    });
  };

  const linked = status?.linked ?? false;
  const relayRunning = status?.relayRunning ?? false;
  const hasTunnels = (tunnels?.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      {/* Account connection */}
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className={`grid h-10 w-10 place-items-center rounded-lg ${linked ? 'bg-[var(--color-grass-deep)]/15 text-[var(--color-grass)]' : 'bg-[var(--color-surface-2)] text-[var(--color-text-soft)]'}`}>
            <Link2 size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              playit.gg account
              <Pill tone={linked ? 'ok' : 'neutral'}>{linked ? 'Linked' : 'Not linked'}</Pill>
              {relayRunning && <Pill tone="ok"><Radio size={11} /> relay live</Pill>}
            </div>
            <div className="text-xs text-[var(--color-text-faint)]">
              {linked ? 'Account linked. Scan finds your tunnels; go online to stream relay logs.' : 'Connect your real playit.gg account (browser approval) to avoid guest-tunnel bans.'}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!linked ? (
            <Button tone="primary" disabled={!!busy} onClick={connect}>
              {busy === 'connect' ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />} Connect playit.gg
            </Button>
          ) : (
            <>
              <Button disabled={!!busy} onClick={connect} title="Re-scan the account for tunnels">
                {busy === 'connect' ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} Re-scan
              </Button>
              {hasTunnels && !relayRunning && (
                <Button tone="primary" disabled={!!busy} onClick={goOnline} title="Start the relay and stream logs">
                  {busy === 'online' ? <Loader2 size={16} className="animate-spin" /> : <Radio size={16} />} Go online
                </Button>
              )}
            </>
          )}
        </div>
      </Card>

      {/* Tunnel control */}
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold">Tunnel control</div>
          <div className="text-xs text-[var(--color-text-faint)]">Create or stop Playit.gg tunnels for this server. Creating may take ~10–30s.</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button tone="primary" disabled={!!busy || !linked} onClick={() => create('java')} title={linked ? 'Create a Java tunnel' : 'Connect your account first'}>
            {busy === 'java' ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Java
          </Button>
          <Button disabled={!!busy || !linked} onClick={() => create('bedrock')} title={linked ? 'Create a Bedrock tunnel' : 'Connect your account first'}>
            {busy === 'bedrock' ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Bedrock
          </Button>
          <Button tone="danger" disabled={!!busy} onClick={stop} title="Stop the running tunnel agent">
            {busy === 'stop' ? <Loader2 size={16} className="animate-spin" /> : <Power size={16} />} Stop
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          icon={<Network size={16} className="text-[var(--color-grass)]" />}
          title={tunnels ? `Tunnels (${tunnels.length})` : 'Tunnels'}
          action={
            <button onClick={load} title="Refresh" className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-text-soft)] hover:text-[var(--color-text)]">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          }
        />

      {loading && !tunnels ? (
        <div className="space-y-2 p-4">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : !tunnels || tunnels.length === 0 ? (
        <EmptyState
          icon={<Network size={28} />}
          title="No tunnels on your playit.gg account"
          hint="Use the Java or Bedrock button above to create one."
        />
      ) : (
        <ul className="divide-y divide-[var(--color-border-soft)]">
          {tunnels.map((t) => {
            const addr = `${t.address}:${t.port}`;
            return (
              <li key={t.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{t.name}</span>
                    <Pill tone={t.proto === 'udp' ? 'info' : 'neutral'}>{t.proto.toUpperCase()}</Pill>
                  </div>
                  <code className="truncate font-mono text-xs text-[var(--color-grass)]">{addr}</code>
                </div>
                <Pill tone={t.active ? 'ok' : 'neutral'}>{t.active ? 'Active' : 'Disabled'}</Pill>
                <button onClick={() => copy(addr)} title="Copy address" className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-text-soft)] hover:text-[var(--color-text)]">
                  {copied === addr ? <Check size={16} className="text-[var(--color-ok)]" /> : <Copy size={16} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      </Card>
    </div>
  );
}
