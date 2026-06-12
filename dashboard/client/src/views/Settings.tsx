import { useEffect, useState } from 'react';
import { Settings as SettingsIcon, Save, Shield, MemoryStick, Loader2 } from 'lucide-react';
import { Card, CardHeader, Button, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import type { Settings } from '../lib/types';
import Switch from '../components/Switch';

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-[var(--color-surface-2)]/40 px-4 pt-4 pb-2 min-h-[82px] w-full">
      <span className="text-sm font-medium text-[var(--color-text)]">{label}</span>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[var(--color-text-soft)]">{label}</span>
      {children}
    </label>
  );
}

const inputCls = 'h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-sm outline-none focus:border-[var(--color-grass)]';

function RamSlider({ s, value, onChange }: { s: Settings; value: number; onChange: (v: number) => void }) {
  const { totalMemGB, recommended } = s;
  const zone = value >= totalMemGB ? 'danger' : value >= recommended.minGB && value <= recommended.maxGB ? 'ok' : 'warn';
  const zoneColor = { ok: 'var(--color-ok)', warn: 'var(--color-warn)', danger: 'var(--color-danger)' }[zone];
  const zoneText = {
    ok: 'Recommended for this server',
    warn: value < recommended.minGB ? 'Below recommended — may lag with more players/mods' : 'More than needed — wastes host RAM',
    danger: `Allocating 100% of available RAM (host has ${totalMemGB} GB)`,
  }[zone];
  const pct = Math.min(100, (value / totalMemGB) * 100);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-bold tabular" style={{ color: zoneColor }}>{value} GB</span>
        <span className="text-xs text-[var(--color-text-faint)] tabular">of {totalMemGB} GB · recommended {recommended.minGB}–{recommended.maxGB} GB</span>
      </div>
      <div className="relative">
        {/* recommended band marker */}
        <div className="pointer-events-none absolute top-1/2 h-2 -translate-y-1/2 rounded bg-[var(--color-grass-deep)]/25"
          style={{ left: `${(recommended.minGB / totalMemGB) * 100}%`, width: `${((recommended.maxGB - recommended.minGB) / totalMemGB) * 100}%` }} />
        <input
          type="range" min={1} max={totalMemGB} step={1} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="relative w-full"
          style={{ accentColor: zoneColor }}
          aria-label="Server RAM allocation in GB"
        />
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]">
          <div className="h-full rounded-full transition-[width,background] duration-200" style={{ width: `${pct}%`, background: zoneColor }} />
        </div>
      </div>
      <div className="text-xs" style={{ color: zoneColor }}>{zoneText}</div>
    </div>
  );
}

export function SettingsView({ showToast }: { showToast: (m: string) => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [form, setForm] = useState<Partial<Settings>>({});
  const [ramGB, setRamGB] = useState(4);
  const [saving, setSaving] = useState(false);
  const [savingRam, setSavingRam] = useState(false);

  const load = () => {
    api.settingsGet().then((d) => { setS(d); setForm(d); setRamGB(d.ramGB); }).catch((e) => showToast(`Load failed: ${e.message}`));
  };
  useEffect(load, []);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => ({ ...f, [k]: v }));

  const handleToggleChange = async <K extends keyof Settings>(k: K, v: Settings[K]) => {
    try {
      showToast('Saving and reloading...');
      await api.settingsPut({ [k]: v });
      window.location.reload();
    } catch (e: any) {
      showToast(`Save failed: ${e.message}`);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const { settings } = await api.settingsPut({
        displayName: form.displayName, motd: form.motd, maxPlayers: form.maxPlayers,
        difficulty: form.difficulty, gamemode: form.gamemode, pvp: form.pvp,
        onlineMode: form.onlineMode, whitelist: form.whitelist, enforceWhitelist: form.enforceWhitelist,
      });
      setS(settings); setForm(settings);
      showToast('Settings saved.');
    } catch (e: any) { showToast(`Save failed: ${e.message}`); }
    finally { setSaving(false); }
  };

  const saveRam = async () => {
    setSavingRam(true);
    try { showToast((await api.ramPut(ramGB)).message); }
    catch (e: any) { showToast(`RAM failed: ${e.message}`); }
    finally { setSavingRam(false); }
  };

  if (!s) return <div className="space-y-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>;

  const ramTooHigh = ramGB > s.totalMemGB;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader icon={<SettingsIcon size={16} className="text-[var(--color-grass)]" />} title="Server profile"
          action={<Button tone="primary" disabled={saving} onClick={save}>{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save</Button>} />
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
          <Field label="Display name (dashboard only)">
            <input className={inputCls} value={form.displayName ?? ''} onChange={(e) => set('displayName', e.target.value)} />
          </Field>
          <Field label="MOTD (shown in the server list)">
            <input className={inputCls} value={form.motd ?? ''} onChange={(e) => set('motd', e.target.value)} />
          </Field>
          <Field label="Max players">
            <input type="number" min={1} className={inputCls} value={form.maxPlayers ?? ''} onChange={(e) => set('maxPlayers', e.target.value)} />
          </Field>
          <Field label="Difficulty">
            <select className={inputCls} value={form.difficulty ?? 'easy'} onChange={(e) => set('difficulty', e.target.value)}>
              {['peaceful', 'easy', 'normal', 'hard'].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Gamemode">
            <select className={inputCls} value={form.gamemode ?? 'survival'} onChange={(e) => set('gamemode', e.target.value)}>
              {['survival', 'creative', 'adventure', 'spectator'].map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </Field>
          <div className="flex items-end"><Toggle label="PVP enabled" checked={!!form.pvp} onChange={(v) => handleToggleChange('pvp', v)} /></div>
        </div>
      </Card>

      <Card>
        <CardHeader icon={<Shield size={16} className="text-[var(--color-grass)]" />} title="Security" />
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
          <Toggle label="Online mode (verify accounts)" checked={!!form.onlineMode} onChange={(v) => handleToggleChange('onlineMode', v)} />
          <Toggle label="Whitelist" checked={!!form.whitelist} onChange={(v) => handleToggleChange('whitelist', v)} />
          <Toggle label="Enforce whitelist" checked={!!form.enforceWhitelist} onChange={(v) => handleToggleChange('enforceWhitelist', v)} />
        </div>
        <div className="px-4 pb-4 text-xs text-[var(--color-text-faint)]">Online mode off allows cracked clients — only disable if you know why. Whitelist changes apply live; enforce-whitelist kicks non-whitelisted players already online.</div>
      </Card>

      <Card>
        <CardHeader icon={<MemoryStick size={16} className="text-[var(--color-grass)]" />} title="Memory allocation"
          action={<Button tone="primary" disabled={savingRam || ramTooHigh} onClick={saveRam}>{savingRam ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Apply</Button>} />
        <div className="p-4">
          <RamSlider s={s} value={ramGB} onChange={setRamGB} />
          <div className="mt-3 text-xs text-[var(--color-text-faint)]">Applies the next time the server starts. Sets both -Xms and -Xmx.</div>
        </div>
      </Card>
    </div>
  );
}
