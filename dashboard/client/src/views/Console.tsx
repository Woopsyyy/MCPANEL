import { useEffect, useRef, useState } from 'react';
import { Terminal, CornerDownLeft, Network } from 'lucide-react';
import { Card } from '../components/ui';

type Source = 'server' | 'playit';

export function ConsoleView({ text, playitText, running, onSend }: {
  text: string; playitText: string; running: boolean; onSend: (cmd: string) => void;
}) {
  const [source, setSource] = useState<Source>('server');
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const scrollRef = useRef<HTMLPreElement>(null);
  const atBottomRef = useRef(true);
  const shown = source === 'server' ? text : playitText;

  // Auto-scroll only when the user is already pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = input.trim();
    if (!cmd) return;
    onSend(cmd);
    setHistory((h) => [...h, cmd]);
    setHistIdx(-1);
    setInput('');
    atBottomRef.current = true;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      if (history[idx] != null) { setHistIdx(idx); setInput(history[idx]); }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx < 0) return;
      const idx = histIdx + 1;
      if (idx >= history.length) { setHistIdx(-1); setInput(''); } else { setHistIdx(idx); setInput(history[idx]); }
    }
  };

  return (
    <Card className="flex h-[calc(100vh-9rem)] flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[var(--color-border-soft)] px-4 py-2.5">
        <div className="flex rounded-lg bg-[var(--color-surface-0)] p-0.5">
          <button
            onClick={() => { setSource('server'); atBottomRef.current = true; }}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${source === 'server' ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]' : 'text-[var(--color-text-soft)]'}`}
          >
            <Terminal size={14} /> Server
          </button>
          <button
            onClick={() => { setSource('playit'); atBottomRef.current = true; }}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${source === 'playit' ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]' : 'text-[var(--color-text-soft)]'}`}
          >
            <Network size={14} /> Playit logs
          </button>
        </div>
        {source === 'server' && !running && <span className="text-xs text-[var(--color-warn)]">server offline — commands won't be delivered</span>}
        {source === 'playit' && <span className="text-xs text-[var(--color-text-faint)]">read-only relay output</span>}
      </div>

      <pre
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words bg-[var(--color-surface-0)] px-4 py-3 font-mono text-xs leading-relaxed text-[var(--color-text-soft)]"
      >
        {shown || (source === 'server' ? 'Waiting for server output…' : 'No Playit relay output yet — start a tunnel to see logs.')}
      </pre>

      {source === 'server' && (
        <form onSubmit={submit} className="flex items-center gap-2 border-t border-[var(--color-border-soft)] p-3">
          <span className="pl-1 font-mono text-sm text-[var(--color-grass)]">{'>'}</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            disabled={!running}
            placeholder={running ? 'Type a server command (e.g. say hello)…' : 'Start the server to send commands'}
            aria-label="Server console command"
            className="min-h-[40px] flex-1 bg-transparent font-mono text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] disabled:opacity-50"
          />
          <button type="submit" disabled={!running || !input.trim()} title="Send" className="grid h-9 w-9 place-items-center rounded-md bg-[var(--color-surface-2)] text-[var(--color-text-soft)] hover:text-[var(--color-text)] disabled:opacity-40">
            <CornerDownLeft size={16} />
          </button>
        </form>
      )}
    </Card>
  );
}
