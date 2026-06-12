import { useEffect, useState } from 'react';
import { FolderSync, HardDriveDownload, Loader2, Check, Smartphone, Download } from 'lucide-react';
import { Card, CardHeader, Button, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import type { MaintenanceInfo } from '../lib/types';

const inputCls = 'h-10 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 font-mono text-sm outline-none focus:border-[var(--color-grass)]';

export function MaintenanceView({ showToast }: { showToast: (m: string) => void }) {
  const [info, setInfo] = useState<MaintenanceInfo | null>(null);
  const [serverPath, setServerPath] = useState('');
  const [backupPath, setBackupPath] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    api.maintenanceGet().then((d) => {
      setInfo(d);
      setServerPath(d.serverPath || '');
      setBackupPath(d.backupLocation || '');
    }).catch((e) => showToast(`Load failed: ${e.message}`));
  };
  useEffect(load, []);

  const syncServer = async () => {
    if (!serverPath.trim()) { showToast('Enter a server folder path.'); return; }
    setBusy('server');
    try { showToast((await api.maintenanceSyncServer(serverPath.trim())).message); load(); }
    catch (e: any) { showToast(`Sync failed: ${e.message}`); }
    finally { setBusy(null); }
  };

  const setBackupLoc = async () => {
    if (!backupPath.trim()) { showToast('Enter a backup folder path.'); return; }
    setBusy('backup');
    try { showToast((await api.maintenanceBackupLocation(backupPath.trim())).message); load(); }
    catch (e: any) { showToast(`Failed: ${e.message}`); }
    finally { setBusy(null); }
  };

  const installGeyser = async () => {
    setBusy('geyser');
    try { showToast((await api.installGeyser()).message); }
    catch (e: any) { showToast(`Geyser install failed: ${e.message}`); }
    finally { setBusy(null); }
  };

  if (!info) return <div className="space-y-4">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-36" />)}</div>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader icon={<FolderSync size={16} className="text-[var(--color-grass)]" />} title="Sync server folder" />
        <div className="space-y-3 p-4">
          <div className="text-xs text-[var(--color-text-faint)]">
            Currently connected: <span className="font-mono text-[var(--color-text-soft)]">{info.serverPath || 'none'}</span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className={inputCls} placeholder="C:\path\to\server" value={serverPath} onChange={(e) => setServerPath(e.target.value)} />
            <Button tone="primary" disabled={busy === 'server'} onClick={syncServer}>
              {busy === 'server' ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Sync server
            </Button>
          </div>
          <div className="text-xs text-[var(--color-text-faint)]">Re-validates the folder and re-detects software/version. Configure this before backing up.</div>
        </div>
      </Card>

      <Card>
        <CardHeader icon={<HardDriveDownload size={16} className="text-[var(--color-grass)]" />} title="Backup location" />
        <div className="space-y-3 p-4">
          <div className="text-xs text-[var(--color-text-faint)]">
            Backups are written to <span className="font-mono text-[var(--color-text-soft)]">{info.backupLocation}\{info.serverName || '<server>'}\</span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className={inputCls} placeholder="C:\path\to\backups" value={backupPath} onChange={(e) => setBackupPath(e.target.value)} />
            <Button tone="primary" disabled={busy === 'backup'} onClick={setBackupLoc}>
              {busy === 'backup' ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Set location
            </Button>
          </div>
          <div className="text-xs text-[var(--color-text-faint)]">Each backup lands in a folder named after the server. World + user data is compressed so you can roll back.</div>
        </div>
      </Card>

      <Card>
        <CardHeader icon={<Smartphone size={16} className="text-[var(--color-grass)]" />} title="Bedrock support (Geyser)" />
        <div className="space-y-3 p-4">
          <div className="text-xs text-[var(--color-text-faint)]">
            Auto-downloads <span className="text-[var(--color-text-soft)]">GeyserMC</span> + <span className="text-[var(--color-text-soft)]">Floodgate</span> for your server type and writes a starter Geyser config (Bedrock port 19132, Floodgate auth) so Bedrock players can join. Restart the server afterwards, then create a Bedrock tunnel.
          </div>
          <Button tone="primary" disabled={busy === 'geyser'} onClick={installGeyser}>
            {busy === 'geyser' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} Install Geyser + Floodgate
          </Button>
          <div className="text-xs text-[var(--color-text-faint)]">Fabric servers also need the Fabric API mod installed.</div>
        </div>
      </Card>
    </div>
  );
}
