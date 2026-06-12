import { useEffect, useRef, useState } from 'react';
import { wsUrl } from './api';
import type { WsMessage } from './types';

/**
 * Single reconnecting WebSocket to the dashboard hub. Surfaces connection state
 * (for the offline banner) and dispatches typed messages to a handler ref so the
 * socket never needs to be torn down when the handler changes.
 */
export function useSocket(onMessage: (msg: WsMessage) => void) {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;
  const sockRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (closed) return;
      const sock = new WebSocket(wsUrl());
      sockRef.current = sock;

      sock.onopen = () => setConnected(true);
      sock.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      sock.onerror = () => { try { sock.close(); } catch { /* ignore */ } };
      sock.onmessage = (ev) => {
        try { handlerRef.current(JSON.parse(ev.data)); } catch { /* ignore */ }
      };
    };

    connect();
    return () => { closed = true; clearTimeout(retry); try { sockRef.current?.close(); } catch { /* ignore */ } };
  }, []);

  const send = (payload: unknown) => {
    const sock = sockRef.current;
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(payload));
  };

  return { connected, send };
}
