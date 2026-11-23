// Signaling over WebSocket: which devices are around, and the WebRTC
// handshake messages between them. Reconnects on its own.
import type { DeviceType } from './identity';

export interface RemotePeer {
  id: string;
  name: string;
  device: DeviceType;
}

export interface SignalHandlers {
  onPeers(peers: RemotePeer[]): void;
  onJoin(peer: RemotePeer): void;
  onLeave(id: string): void;
  onSignal(from: string, data: unknown): void;
  onState(open: boolean): void;
}

export class Signal {
  private ws?: WebSocket;
  private closed = false;
  private retry = 0;
  private ping?: number;

  constructor(
    private me: { id: string; name: string; device: DeviceType },
    private h: SignalHandlers,
    public code?: string,
  ) {
    this.connect();
  }

  private connect() {
    const q = new URLSearchParams({ id: this.me.id, name: this.me.name, device: this.me.device });
    if (this.code) q.set('code', this.code);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws?${q}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.h.onState(true);
      this.ping = window.setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 25_000);
    };
    ws.onmessage = (e) => {
      let m: { type: string; peers?: RemotePeer[]; peer?: RemotePeer; id?: string; from?: string; data?: unknown };
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === 'peers') this.h.onPeers(m.peers ?? []);
      else if (m.type === 'join' && m.peer) this.h.onJoin(m.peer);
      else if (m.type === 'leave' && m.id) this.h.onLeave(m.id);
      else if (m.type === 'signal' && m.from) this.h.onSignal(m.from, m.data);
    };
    ws.onclose = (e) => {
      clearInterval(this.ping);
      this.h.onState(false);
      this.h.onPeers([]);
      if (this.closed || e.code === 4000) return;
      setTimeout(() => !this.closed && this.connect(), Math.min(15_000, 500 * 2 ** this.retry++));
    };
  }

  send(to: string, data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'signal', to, data }));
  }

  rename(name: string) {
    this.me = { ...this.me, name };
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'rename', name }));
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
