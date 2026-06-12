import { useEffect, useState } from 'react';
import { Archive, RefreshCw, Plus, RotateCcw, HardDriveDownload, Clock } from 'lucide-react';
import { Card, CardHeader, EmptyState, Skeleton, Button, fmtBytes } from '../components/ui';
import { api } from '../lib/api';
import type { Backup, ScheduleState } from '../lib/types';
import Switch from '../components/Switch';

function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'due now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `in ${h}h ${m}m`;
  const s = Math.floor((ms % 60000) / 1000);
  return m > 0 ? `in ${m}m` : `in ${s}s`;
}

function ScheduleCard({ showToast }: { showToast: (m: string) => void }) {
  const [state, setState] = useState<ScheduleState | null>(null);
  const [hours, setHours] = useState(24);
  const [keep, setKeep] = useState(5);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    api.scheduleGet().then((s) => { setState(s); setHours(s.intervalHours); setKeep(s.maxBackups); }).catch(() => { /* ignore */ });
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const save = async (enabled: boolean) => {
    setSaving(true);
    try {
      const s = await api.schedulePut(enabled, hours, keep);
      setState(s); setHours(s.intervalHours); setKeep(s.maxBackups);
      showToast(enabled ? `Automatic backups on — every ${s.intervalHours}h, keeping ${s.maxBackups}.` : 'Automatic backups off.');
      window.location.reload();
    } catch (e: any) { showToast(`Schedule failed: ${e.message}`); }
    finally { setSaving(false); }
  };

  const enabled = state?.enabled ?? false;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Clock size={16} className="text-[var(--color-grass)]" /> Automatic backups
        </div>
        <Switch checked={enabled} disabled={saving} onChange={(v) => save(v)} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-soft)]">
          Every
          <input
            type="number" min={1} max={168} value={hours}
            onChange={(e) => setHours(Math.max(1, Math.min(168, Number(e.target.value) || 1)))}
            className="h-10 w-20 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 text-center tabular outline-none focus:border-[var(--color-grass)]"
          />
          hours
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-soft)]">
          Keep
          <input
            type="number" min={1} max={100} value={keep}
            onChange={(e) => setKeep(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
            className="h-10 w-20 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 text-center tabular outline-none focus:border-[var(--color-grass)]"
          />
          backups
        </label>
        <Button disabled={saving} onClick={() => save(enabled)}>Save</Button>
        <div className="text-xs text-[var(--color-text-faint)] tabular">
          {enabled && state?.nextRunMs ? `Next backup ${fmtCountdown(state.nextRunMs - now)}` : 'Disabled'}
          {state?.lastResult ? ` · Last: ${state.lastResult}` : ''}
        </div>
      </div>
      <div className="mt-2 text-xs text-[var(--color-text-faint)]">
        While the server is running, automatic backups use save-off → flush → zip → save-on so a live world is captured safely.
      </div>
    </Card>
  );
}

export function BackupsView({ showToast }: { showToast: (msg: string) => void }) {
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.backups().then((r) => setBackups(r.backups)).catch(() => setBackups([])).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const create = async () => {
    setBusy(true);
    try { showToast((await api.backupCreate()).message); load(); }
    catch (e: any) { showToast(`Backup failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  const restore = async (id: string) => {
    setBusy(true);
    setConfirmId(null);
    try { showToast((await api.backupRestore(id)).message); }
    catch (e: any) { showToast(`Restore failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <ScheduleCard showToast={showToast} />
      <Card>
      <CardHeader
        icon={<Archive size={16} className="text-[var(--color-grass)]" />}
        title={backups ? `Backups (${backups.length})` : 'Backups'}
        action={
          <div className="flex items-center gap-2">
            <button onClick={load} title="Refresh" className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-text-soft)] hover:text-[var(--color-text)]">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
            <Button tone="primary" disabled={busy} onClick={create} title="Create a backup now">
              <Plus size={16} /> Backup now
            </Button>
          </div>
        }
      />

      {loading && !backups ? (
        <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : !backups || backups.length === 0 ? (
        <EmptyState
          icon={<HardDriveDownload size={28} />}
          title="No backups yet"
          hint="Create one with Backup now. Stop the server first to avoid world corruption."
        />
      ) : (
        <ul className="divide-y divide-[var(--color-border-soft)]">
          {backups.map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-4 py-3">
              <Archive size={18} className="shrink-0 text-[var(--color-text-faint)]" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs text-[var(--color-text-soft)]">{b.id}</div>
                <div className="text-xs text-[var(--color-text-faint)] tabular">
                  {new Date(b.createdAt).toLocaleString()} · {fmtBytes(b.sizeBytes)}
                </div>
              </div>
              {confirmId === b.id ? (
                <div className="flex items-center gap-2">
                  <span className="hidden text-xs text-[var(--color-warn)] sm:inline">Overwrite current world?</span>
                  <Button tone="danger" disabled={busy} onClick={() => restore(b.id)}>Confirm</Button>
                  <Button onClick={() => setConfirmId(null)}>Cancel</Button>
                </div>
              ) : (
                <Button disabled={busy} onClick={() => setConfirmId(b.id)} title="Restore this backup">
                  <RotateCcw size={15} /> <span className="hidden sm:inline">Restore</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      </Card>
    </div>
  );
}
