import type { ServerMsg } from './types';

type Listener = (msg: ServerMsg) => void;

/** Auto-reconnecting WebSocket to the shmakk server. */
class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(online: boolean) => void>();
  private queue: string[] = [];
  private retry = 0;
  private closed = false;
  online = false;

  connect() {
    this.closed = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setOnline(true);
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      this.setOnline(false);
      if (this.closed) return;
      const delay = Math.min(8000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private setOnline(v: boolean) {
    if (this.online === v) return;
    this.online = v;
    for (const l of this.statusListeners) l(v);
  }

  send(msg: Record<string, unknown>) {
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (!String(msg.t).startsWith('term.')) this.queue.push(data);
  }

  on(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  onStatus(l: (online: boolean) => void) { this.statusListeners.add(l); return () => { this.statusListeners.delete(l); }; }
}

export const socket = new Socket();
