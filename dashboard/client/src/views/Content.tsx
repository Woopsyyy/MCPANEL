import { useEffect, useRef, useState } from 'react';
import { Package, RefreshCw, FileBox, UploadCloud, Trash2, Loader2 } from 'lucide-react';
import { Card, CardHeader, EmptyState, Skeleton, fmtBytes } from '../components/ui';
import { api } from '../lib/api';
import type { ContentListing } from '../lib/types';

export function ContentView({ onCount, showToast }: { onCount: (n: number) => void; showToast: (m: string) => void }) {
  const [data, setData] = useState<ContentListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setLoading(true);
    api.content()
      .then((c) => { setData(c); onCount(c.items.length); })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const upload = async (files: File[]) => {
    const jars = files.filter((f) => f.name.toLowerCase().endsWith('.jar'));
    if (jars.length === 0) { showToast('Only .jar files can be uploaded.'); return; }
    setUploading(true);
    try { showToast((await api.contentUpload(jars)).message); load(); }
    catch (e: any) { showToast(`Upload failed: ${e.message}`); }
    finally { setUploading(false); }
  };

  const remove = async (file: string) => {
    setDeleting(file);
    try { showToast((await api.contentDelete(file)).message); load(); }
    catch (e: any) { showToast(`Remove failed: ${e.message}`); }
    finally { setDeleting(null); }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    upload(Array.from(e.dataTransfer.files));
  };

  const kindLabel = data?.kind === 'mods' ? 'Mods' : 'Plugins';
  const kindSingular = data?.kind === 'mods' ? 'mod' : 'plugin';

  return (
    <div className="space-y-4">
      {/* Drag-and-drop upload zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
          dragging ? 'border-[var(--color-grass)] bg-[var(--color-grass-deep)]/10' : 'border-[var(--color-border)] hover:border-[var(--color-border)]/80'
        }`}
      >
        {uploading
          ? <Loader2 size={26} className="animate-spin text-[var(--color-grass)]" />
          : <UploadCloud size={26} className="text-[var(--color-text-soft)]" />}
        <div className="text-sm font-medium">
          {uploading ? 'Uploading…' : <>Drop {kindSingular} <span className="font-mono">.jar</span> files here, or click to browse</>}
        </div>
        <div className="text-xs text-[var(--color-text-faint)]">Files install into the server's {data?.kind ?? 'content'} folder</div>
        <input
          ref={inputRef}
          type="file"
          accept=".jar"
          multiple
          className="hidden"
          onChange={(e) => { upload(Array.from(e.target.files || [])); e.target.value = ''; }}
        />
      </div>

      <Card>
        <CardHeader
          icon={<Package size={16} className="text-[var(--color-grass)]" />}
          title={data ? `${kindLabel} (${data.items.length})` : 'Content'}
          action={
            <button onClick={load} title="Refresh" className="grid h-8 w-8 place-items-center rounded-md text-[var(--color-text-soft)] hover:text-[var(--color-text)]">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          }
        />

        {loading && !data ? (
          <div className="space-y-2 p-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : !data || !data.exists ? (
          <EmptyState icon={<FileBox size={28} />} title="No content folder yet" hint="Drop a .jar above or start the server once to generate the folder." />
        ) : data.items.length === 0 ? (
          <EmptyState icon={<FileBox size={28} />} title={`No ${kindLabel.toLowerCase()} installed`} hint="Drag a .jar onto the upload zone above." />
        ) : (
          <ul className="divide-y divide-[var(--color-border-soft)]">
            {data.items.map((it) => (
              <li key={it.file} className="flex items-center gap-3 px-4 py-3">
                <FileBox size={18} className="shrink-0 text-[var(--color-text-faint)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{it.name}</div>
                  <div className="truncate font-mono text-xs text-[var(--color-text-faint)]">{it.file}</div>
                </div>
                <span className="shrink-0 rounded bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-xs text-[var(--color-text-soft)]">v{it.version}</span>
                <span className="hidden w-16 shrink-0 text-right text-xs text-[var(--color-text-faint)] tabular sm:block">{fmtBytes(it.sizeBytes)}</span>
                <button
                  onClick={() => remove(it.file)}
                  disabled={deleting === it.file}
                  title={`Remove ${it.file}`}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-[var(--color-text-faint)] hover:bg-red-500/10 hover:text-[var(--color-danger)] disabled:opacity-40"
                >
                  {deleting === it.file ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
