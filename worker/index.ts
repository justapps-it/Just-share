// JustShare edge: signaling only. It introduces devices to each other
// (WebSocket rooms) and hands out ICE servers. File data never goes through
// here: it flows device-to-device over WebRTC, end-to-end encrypted.

import { DurableObject } from 'cloudflare:workers';

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  ROOMS: DurableObjectNamespace<Room>;
  TURN_KEY_ID?: string;
  TURN_KEY_TOKEN?: string;
}

interface Peer {
  id: string;
  name: string;
  device: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Devices behind the same public address (same Wi-Fi) share a room. */
async function networkRoom(req: Request): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') ?? '0.0.0.0';
  // IPv6: every device has its own address, the /64 prefix is the network.
  const net = ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
  return `net:${await sha256(`justshare:${net}`)}`;
}

/** STUN always; TURN relay credentials when configured (Cloudflare Realtime TURN). */
async function iceServers(env: Env) {
  const stun = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] };
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return json({ iceServers: [stun], relay: false });
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.TURN_KEY_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 6 * 3600 }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { iceServers: unknown };
    const servers = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
    return json({ iceServers: [stun, ...servers], relay: true });
  } catch {
    return json({ iceServers: [stun], relay: false });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/ice') return iceServers(env);
    if (url.pathname === '/api/ws') {
      if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
      const code = url.searchParams.get('code');
      let room: string;
      if (code) {
        if (!/^\d{6}$/.test(code)) return json({ error: 'bad_code' }, 400);
        room = `code:${code}`;
      } else room = await networkRoom(req);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      return stub.fetch(req);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    return env.ASSETS.fetch(req);
  },
};

/**
 * One room = one network or one pairing code. Uses WebSocket hibernation:
 * idle rooms cost nothing. Peers' info lives in the socket attachment.
 */
export class Room extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const peer: Peer = {
      id: (url.searchParams.get('id') ?? '').slice(0, 40),
      name: (url.searchParams.get('name') ?? 'Device').slice(0, 40),
      device: (url.searchParams.get('device') ?? 'phone').slice(0, 12),
    };
    if (!/^[\w-]{8,40}$/.test(peer.id)) return json({ error: 'bad_id' }, 400);

    // A device reconnecting replaces its previous socket.
    for (const ws of this.ctx.getWebSockets(peer.id)) ws.close(4000, 'replaced');
    const others = this.peers().filter((p) => p.id !== peer.id);
    if (others.length >= 64) return json({ error: 'room_full' }, 429);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [peer.id]);
    server.serializeAttachment(peer);
    server.send(JSON.stringify({ type: 'peers', you: peer.id, peers: others }));
    this.broadcast({ type: 'join', peer }, peer.id);
    return new Response(null, { status: 101, webSocket: client });
  }

  private peers(): Peer[] {
    return this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment() as Peer).filter(Boolean);
  }

  private broadcast(msg: unknown, except?: string) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const p = ws.deserializeAttachment() as Peer | null;
      if (p && p.id !== except) {
        try {
          ws.send(text);
        } catch {
          /* closing */
        }
      }
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > 64 * 1024) return;
    const me = ws.deserializeAttachment() as Peer;
    let msg: { type?: string; to?: string; data?: unknown; name?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'signal' && typeof msg.to === 'string') {
      for (const target of this.ctx.getWebSockets(msg.to)) target.send(JSON.stringify({ type: 'signal', from: me.id, data: msg.data }));
    } else if (msg.type === 'rename' && typeof msg.name === 'string') {
      const peer = { ...me, name: msg.name.slice(0, 40) };
      ws.serializeAttachment(peer);
      this.broadcast({ type: 'join', peer }, me.id);
    } else if (msg.type === 'ping') {
      ws.send('{"type":"pong"}');
    }
  }

  async webSocketClose(ws: WebSocket) {
    const me = ws.deserializeAttachment() as Peer | null;
    if (me && !this.ctx.getWebSockets(me.id).some((s) => s !== ws)) this.broadcast({ type: 'leave', id: me.id });
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }
}
