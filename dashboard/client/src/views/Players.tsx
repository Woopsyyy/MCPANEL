import { useState } from 'react';
import { Users } from 'lucide-react';
import { Card, CardHeader, EmptyState, Pill } from '../components/ui';
import type { PlayerInfo } from '../lib/types';

/** Player head avatar with a graceful fallback to initials if the skin service fails. */
function Head({ player }: { player: PlayerInfo }) {
  const [failed, setFailed] = useState(false);
  // Bedrock (Geyser) names carry a prefix like ".Name" — strip it for the lookup.
  const clean = player.name.replace(/^[.*_]/, '');
  const initials = clean.slice(0, 2).toUpperCase();

  if (failed || player.platform === 'bedrock') {
    // Bedrock players have no Java skin service, so always show initials.
    return (
      <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-md font-mono text-sm ${player.platform === 'bedrock' ? 'bg-sky-500/15 text-[var(--color-info)]' : 'bg-[var(--color-surface-2)] text-[var(--color-grass)]'}`}>
        {initials}
      </div>
    );
  }
  return (
    <img
      src={`https://mc-heads.net/avatar/${encodeURIComponent(clean)}/40`}
      alt={clean}
      width={40}
      height={40}
      onError={() => setFailed(true)}
      className="h-10 w-10 shrink-0 rounded-md"
      style={{ imageRendering: 'pixelated' }}
    />
  );
}

export function PlayersView({ players, running }: { players: PlayerInfo[]; running: boolean }) {
  return (
    <Card>
      <CardHeader icon={<Users size={16} className="text-[var(--color-grass)]" />} title={`Players online (${players.length})`} />
      {players.length === 0 ? (
        <EmptyState
          icon={<Users size={28} />}
          title={running ? 'Nobody is online right now' : 'Server is offline'}
          hint={running ? 'Players appear here the moment they join.' : 'Start the server to track who joins.'}
        />
      ) : (
        <ul className="divide-y divide-[var(--color-border-soft)]">
          {players.map((p) => (
            <li key={p.name} className="flex items-center gap-3 px-4 py-3">
              <Head player={p} />
              <span className="font-medium">{p.name.replace(/^[.*_]/, '')}</span>
              <Pill tone={p.platform === 'bedrock' ? 'info' : 'neutral'}>
                {p.platform === 'bedrock' ? 'Bedrock' : 'Java'}
              </Pill>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
