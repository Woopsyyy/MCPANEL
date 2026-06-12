import type { ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface-1)] ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ icon, title, action }: { icon?: ReactNode; title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--color-border-soft)] px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
        {icon}
        {title}
      </div>
      {action}
    </div>
  );
}

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
const toneStyles: Record<Tone, string> = {
  ok: 'bg-green-500/10 text-[var(--color-ok)] border-green-500/20',
  warn: 'bg-amber-400/10 text-[var(--color-warn)] border-amber-400/20',
  danger: 'bg-red-400/10 text-[var(--color-danger)] border-red-400/20',
  info: 'bg-sky-400/10 text-[var(--color-info)] border-sky-400/20',
  neutral: 'bg-zinc-500/10 text-[var(--color-text-soft)] border-zinc-500/20',
};

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${toneStyles[tone]}`}>
      {children}
    </span>
  );
}

export function Button({
  children, onClick, tone = 'default', disabled, title,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  title?: string;
}) {
  const tones = {
    default: 'bg-[var(--color-surface-2)] hover:bg-zinc-700 text-[var(--color-text)] border-[var(--color-border)]',
    primary: 'bg-[var(--color-grass-deep)] hover:bg-green-500 text-zinc-950 border-transparent font-semibold',
    danger: 'bg-red-500/15 hover:bg-red-500/25 text-[var(--color-danger)] border-red-500/30',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-[var(--color-surface-2)] ${className}`} />;
}

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="text-[var(--color-text-faint)]">{icon}</div>
      <div className="text-sm font-medium text-[var(--color-text-soft)]">{title}</div>
      {hint && <div className="max-w-sm text-xs text-[var(--color-text-faint)]">{hint}</div>}
    </div>
  );
}

/** Tiny dependency-free sparkline. Values are 0..max (default 100). */
export function Sparkline({ data, max = 100, color = 'var(--color-grass)', height = 32 }: {
  data: number[]; max?: number; color?: string; height?: number;
}) {
  const width = 100;
  if (data.length < 2) {
    return <div style={{ height }} className="flex items-center text-xs text-[var(--color-text-faint)]">Collecting…</div>;
  }
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(2)},${(height - (Math.min(v, max) / max) * height).toFixed(2)}`);
  const line = pts.join(' ');
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden="true">
      <polygon points={area} fill={color} opacity={0.12} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Area+line time-series chart (SVG, no deps). `data` are 0..max values. */
export function Chart({ data, max = 100, color = 'var(--color-grass)', height = 120, unit = '%' }: {
  data: number[]; max?: number; color?: string; height?: number; unit?: string;
}) {
  const width = 300;
  const id = color.replace(/[^a-z]/gi, '');
  if (data.length < 2) {
    return (
      <div style={{ height }} className="flex items-center justify-center text-xs text-[var(--color-text-faint)]">
        Collecting data…
      </div>
    );
  }
  const step = width / (data.length - 1);
  const y = (v: number) => height - (Math.min(Math.max(v, 0), max) / max) * (height - 6) - 3;
  const pts = data.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`);
  const line = pts.join(' ');
  const area = `0,${height} ${line} ${width},${height}`;
  const latest = data[data.length - 1];
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label={`${latest}${unit} latest`}>
        <defs>
          <linearGradient id={`g-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" y1={height * f} x2={width} y2={height * f} stroke="var(--color-border-soft)" strokeWidth={0.5} />
        ))}
        <polygon points={area} fill={`url(#g-${id})`} />
        <polyline points={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
