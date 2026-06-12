import { LayoutDashboard, Users, Package, Network, Terminal, Archive, Box, Settings, Wrench } from 'lucide-react';

export type View = 'overview' | 'players' | 'content' | 'tunnels' | 'console' | 'backups' | 'settings' | 'maintenance';

const items: { id: View; label: string; icon: typeof Users; badge?: (ctx: BadgeCtx) => number | null }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'players', label: 'Players', icon: Users, badge: (c) => c.players || null },
  { id: 'content', label: 'Content', icon: Package, badge: (c) => c.content || null },
  { id: 'tunnels', label: 'Tunnels', icon: Network },
  { id: 'console', label: 'Console', icon: Terminal },
  { id: 'backups', label: 'Backups', icon: Archive },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'maintenance', label: 'Maintenance', icon: Wrench },
];

interface BadgeCtx { players: number; content: number }

export function Sidebar({
  active, onSelect, badgeCtx,
}: {
  active: View;
  onSelect: (v: View) => void;
  badgeCtx: BadgeCtx;
}) {
  return (
    <aside className="flex w-16 shrink-0 flex-col border-r border-[var(--color-border-soft)] bg-[var(--color-surface-1)] py-4 md:w-60">
      <div className="mb-6 flex items-center gap-2.5 px-3 md:px-5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-grass-deep)] text-zinc-950">
          <Box size={20} strokeWidth={2.5} />
        </div>
        <div className="hidden md:block">
          <div className="text-sm font-bold leading-tight">MCPANEL</div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Dashboard</div>
        </div>
      </div>

      <nav className="flex flex-col gap-1 px-2 md:px-3">
        {items.map((it) => {
          const Icon = it.icon;
          const isActive = active === it.id;
          const badge = it.badge?.(badgeCtx) ?? null;
          return (
            <button
              key={it.id}
              onClick={() => onSelect(it.id)}
              className={`group flex min-h-[44px] items-center gap-3 rounded-lg px-3 text-sm transition-colors ${
                isActive
                  ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                  : 'text-[var(--color-text-soft)] hover:bg-[var(--color-surface-2)]/50 hover:text-[var(--color-text)]'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon size={18} className={isActive ? 'text-[var(--color-grass)]' : ''} />
              <span className="hidden flex-1 text-left md:inline">{it.label}</span>
              {badge != null && (
                <span className="hidden rounded-full bg-[var(--color-grass-deep)]/20 px-2 text-xs font-semibold text-[var(--color-grass)] tabular md:inline">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
