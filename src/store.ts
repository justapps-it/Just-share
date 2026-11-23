// App state: devices around, links to them, transfers.
import { useSyncExternalStore } from 'react';
import { Hasher } from './lib/crypto';
import { deviceId, deviceName, deviceType, saveName, type DeviceType } from './lib/identity';
import { iceServers, Link, type LinkState } from './lib/link';
import { Signal, type RemotePeer } from './lib/signal';

export interface Device extends RemotePeer {
  /** How we know it: same network, or paired with a code. */
  via: ('net' | 'code')[];
}

export interface FileMeta {
  name: string;
  size: number;
  type: string;
}

export interface ReceivedFile extends FileMeta {
  url: string;
  file: File;
  verified: boolean;
}

export type TransferStatus = 'connecting' | 'waiting' | 'asking' | 'sending' | 'receiving' | 'done' | 'declined' | 'cancelled' | 'error';

export interface Transfer {
  id: string;
  peerId: string;
  peerName: string;
  direction: 'out' | 'in';
  files: FileMeta[];
  text?: string;
  total: number;
  done: number;
  speed: number;
  status: TransferStatus;
  sas?: string;
  route?: Link['route'];
  received: ReceivedFile[];
  error?: string;
  at: number;
}

interface State {
  me: { id: string; name: string; device: DeviceType };
  online: boolean;
  devices: Device[];
  code: string | null;
  codeOnline: boolean;
  transfers: Transfer[];
}

const CHUNK = 64 * 1024 - 64;
const READ = 2 * 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

type Control =
  | { t: 'offer'; id: string; files: FileMeta[]; text?: string; name: string }
  | { t: 'accept'; id: string }
  | { t: 'decline'; id: string }
  | { t: 'end'; id: string; index: number; hash: string }
  | { t: 'done'; id: string }
  | { t: 'cancel'; id: string };

function controlFrame(c: Control): Uint8Array {
  const body = enc.encode(JSON.stringify(c));
  const f = new Uint8Array(body.length + 1);
  f[0] = 1;
  f.set(body, 1);
  return f;
}

// ---- receiving storage: Origin Private File System when possible --------------
interface Sink {
  write(chunk: Uint8Array): void;
  finish(): Promise<File>;
}

async function opfsDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('incoming', { create: true });
  } catch {
    return null;
  }
}

async function createSink(meta: FileMeta, key: string): Promise<Sink> {
  const dir = meta.size > 32 * 1024 * 1024 ? await opfsDir() : null;
  if (dir) {
    try {
      const handle = await dir.getFileHandle(key, { create: true });
      const writable = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      let chain = Promise.resolve();
      return {
        write(chunk) {
          const copy = chunk.slice();
          chain = chain.then(() => writable.write(copy));
        },
        async finish() {
          await chain;
          await writable.close();
          const f = await handle.getFile();
          return new File([f], meta.name, { type: meta.type || f.type });
        },
      };
    } catch {
      /* fall back to memory */
    }
  }
  const parts: Uint8Array[] = [];
  return {
    write(chunk) {
      parts.push(chunk.slice());
    },
    async finish() {
      return new File(parts as BlobPart[], meta.name, { type: meta.type || 'application/octet-stream' });
    },
  };
}

// ---- store ----------------------------------------------------------------------
class Store {
  private listeners = new Set<() => void>();
  state: State;
  private net?: Signal;
  private codeSignal?: Signal;
  private peers = { net: new Map<string, RemotePeer>(), code: new Map<string, RemotePeer>() };
  private links = new Map<string, Link>();
  private incoming = new Map<string, { sinks: Map<number, Sink>; hashers: Map<number, Hasher>; files: (ReceivedFile | null)[]; lastTick: number; lastBytes: number }>();
  private outgoing = new Map<string, { files: File[]; abort: boolean }>();
  private waiters = new Map<string, (ok: boolean) => void>();

  constructor() {
    const lang = navigator.language?.toLowerCase().startsWith('it') ? 'it' : 'en';
    this.state = {
      me: { id: deviceId(), name: deviceName(lang), device: deviceType() },
      online: false,
      devices: [],
      code: null,
      codeOnline: false,
      transfers: [],
    };
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.state;
  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  private setTransfer(id: string, patch: Partial<Transfer>) {
    this.set({ transfers: this.state.transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  }

  start() {
    if (this.net) return;
    void opfsDir().then((d) => d && (d as unknown as { remove?: (o: object) => Promise<void> }).remove?.({ recursive: true }).catch(() => {}));
    this.net = new Signal(this.state.me, this.handlers('net'));
    const fromLink = location.hash.match(/c=(\d{6})/)?.[1];
    if (fromLink) {
      history.replaceState(null, '', location.pathname);
      this.joinCode(fromLink);
    }
  }

  private handlers(kind: 'net' | 'code') {
    const map = this.peers[kind];
    return {
      onPeers: (list: RemotePeer[]) => {
        map.clear();
        list.forEach((p) => map.set(p.id, p));
        this.refreshDevices();
      },
      onJoin: (p: RemotePeer) => {
        map.set(p.id, p);
        this.refreshDevices();
      },
      onLeave: (id: string) => {
        map.delete(id);
        this.refreshDevices();
      },
      onSignal: (from: string, data: unknown) => void this.onSignal(kind, from, data),
      onState: (open: boolean) => this.set(kind === 'net' ? { online: open } : { codeOnline: open }),
    };
  }

  private refreshDevices() {
    const all = new Map<string, Device>();
    for (const kind of ['net', 'code'] as const) {
      for (const p of this.peers[kind].values()) {
        const d = all.get(p.id);
        if (d) d.via.push(kind);
        else all.set(p.id, { ...p, via: [kind] });
      }
    }
    this.set({ devices: [...all.values()].sort((a, b) => a.name.localeCompare(b.name)) });
  }

  rename(name: string) {
    const n = name.trim().slice(0, 40);
    if (!n) return;
    saveName(n);
    this.set({ me: { ...this.state.me, name: n } });
    this.net?.rename(n);
    this.codeSignal?.rename(n);
  }

  // ---- pairing code ------------------------------------------------------------
  newCode() {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
    this.joinCode(String(n).padStart(6, '0'));
  }

  joinCode(code: string) {
    this.codeSignal?.close();
    this.peers.code.clear();
    this.codeSignal = new Signal(this.state.me, this.handlers('code'), code);
    this.set({ code });
    this.refreshDevices();
  }

  leaveCode() {
    this.codeSignal?.close();
    this.codeSignal = undefined;
    this.peers.code.clear();
    this.set({ code: null, codeOnline: false });
    this.refreshDevices();
  }

  // ---- links ---------------------------------------------------------------------
  private signalFor(peerId: string): Signal | undefined {
    if (this.peers.net.has(peerId)) return this.net;
    if (this.peers.code.has(peerId)) return this.codeSignal;
    return this.net;
  }

  private async link(peerId: string): Promise<Link> {
    const existing = this.links.get(peerId);
    if (existing && existing.state !== 'closed' && existing.state !== 'failed') return existing;
    const servers = await iceServers();
    const again = this.links.get(peerId);
    if (again && again.state !== 'closed' && again.state !== 'failed') return again;
    const l = new Link(
      this.state.me.id,
      peerId,
      servers,
      (data) => this.signalFor(peerId)?.send(peerId, data),
      (plain) => this.enqueue(peerId, plain),
      (s) => this.onLinkState(peerId, s),
    );
    this.links.set(peerId, l);
    return l;
  }

  private async onSignal(_kind: 'net' | 'code', from: string, data: unknown) {
    const l = await this.link(from);
    await l.handleSignal(data as Parameters<Link['handleSignal']>[0]);
  }

  private onLinkState(peerId: string, s: LinkState) {
    const l = this.links.get(peerId);
    for (const t of this.state.transfers) {
      if (t.peerId !== peerId) continue;
      if (l?.route && t.route !== l.route) this.setTransfer(t.id, { route: l.route });
      if ((s === 'failed' || s === 'closed') && ['connecting', 'waiting', 'sending', 'receiving', 'asking'].includes(t.status)) {
        this.setTransfer(t.id, { status: 'error', error: s === 'failed' ? 'connection_failed' : 'connection_closed' });
      }
    }
    if (s === 'closed' || s === 'failed') this.links.delete(peerId);
  }

  // ---- sending ---------------------------------------------------------------------
  async send(peerId: string, files: File[], text?: string) {
    const peer = this.state.devices.find((d) => d.id === peerId);
    const id = crypto.randomUUID();
    const metas = files.map((f) => ({ name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, size: f.size, type: f.type }));
    const total = metas.reduce((n, f) => n + f.size, 0);
    this.set({
      transfers: [
        { id, peerId, peerName: peer?.name ?? '?', direction: 'out', files: metas, text, total, done: 0, speed: 0, status: 'connecting', received: [], at: Date.now() },
        ...this.state.transfers,
      ],
    });
    this.outgoing.set(id, { files, abort: false });
    try {
      const l = await this.link(peerId);
      const session = await l.ready();
      this.setTransfer(id, { sas: session.sas, status: 'waiting', route: l.route });
      const accepted = new Promise<boolean>((r) => this.waiters.set(id, r));
      await l.send(controlFrame({ t: 'offer', id, files: metas, text, name: this.state.me.name }));
      if (!(await accepted)) {
        this.setTransfer(id, { status: 'declined' });
        return;
      }
      this.setTransfer(id, { status: 'sending' });
      let sent = 0;
      let lastTick = performance.now();
      let lastSent = 0;
      for (let i = 0; i < files.length; i++) {
        const hasher = await Hasher.create();
        const f = files[i];
        for (let off = 0; off < f.size; off += READ) {
          const block = new Uint8Array(await f.slice(off, off + READ).arrayBuffer());
          hasher.update(block);
          for (let p = 0; p < block.length; p += CHUNK) {
            if (this.outgoing.get(id)?.abort) throw new Error('cancelled');
            const part = block.subarray(p, p + CHUNK);
            const frame = new Uint8Array(part.length + 3);
            frame[0] = 2;
            frame[1] = i >> 8;
            frame[2] = i & 255;
            frame.set(part, 3);
            await l.send(frame);
            sent += part.length;
          }
          const now = performance.now();
          if (now - lastTick > 400) {
            this.setTransfer(id, { done: sent, speed: ((sent - lastSent) * 1000) / (now - lastTick) });
            lastTick = now;
            lastSent = sent;
          }
        }
        await l.send(controlFrame({ t: 'end', id, index: i, hash: hasher.hex() }));
      }
      await l.send(controlFrame({ t: 'done', id }));
      await l.drain();
      this.setTransfer(id, { status: 'done', done: total, speed: 0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setTransfer(id, { status: msg === 'cancelled' ? 'cancelled' : 'error', error: msg });
    } finally {
      this.outgoing.delete(id);
      this.waiters.delete(id);
    }
  }

  cancel(id: string) {
    const t = this.state.transfers.find((x) => x.id === id);
    if (!t) return;
    const o = this.outgoing.get(id);
    if (o) o.abort = true;
    this.waiters.get(id)?.(false);
    void this.links.get(t.peerId)?.send(controlFrame({ t: 'cancel', id })).catch(() => {});
    this.incoming.delete(id);
    this.setTransfer(id, { status: 'cancelled' });
  }

  // ---- receiving -------------------------------------------------------------------
  private queues = new Map<string, Promise<void>>();

  /** Frames of one device are handled strictly in order. */
  private enqueue(peerId: string, plain: Uint8Array) {
    const prev = this.queues.get(peerId) ?? Promise.resolve();
    this.queues.set(
      peerId,
      prev.then(() => this.onFrame(peerId, plain)).catch(() => {}),
    );
  }

  private async onFrame(peerId: string, plain: Uint8Array) {
    if (plain[0] === 1) {
      const c = JSON.parse(dec.decode(plain.subarray(1))) as Control;
      await this.onControl(peerId, c);
    } else if (plain[0] === 2) {
      const index = (plain[1] << 8) | plain[2];
      const t = this.state.transfers.find((x) => x.peerId === peerId && x.direction === 'in' && x.status === 'receiving');
      if (!t) return;
      const inc = this.incoming.get(t.id);
      if (!inc) return;
      let sink = inc.sinks.get(index);
      if (!sink) {
        sink = await createSink(t.files[index], `${t.id}-${index}`);
        inc.sinks.set(index, sink);
        inc.hashers.set(index, await Hasher.create());
      }
      const data = plain.subarray(3);
      sink.write(data);
      inc.hashers.get(index)!.update(data);
      const done = t.done + data.length;
      const now = performance.now();
      if (now - inc.lastTick > 400) {
        this.setTransfer(t.id, { done, speed: ((done - inc.lastBytes) * 1000) / (now - inc.lastTick) });
        inc.lastTick = now;
        inc.lastBytes = done;
      } else {
        // Keep the counter exact without re-rendering on every chunk.
        t.done = done;
      }
    }
  }

  private async onControl(peerId: string, c: Control) {
    const t = this.state.transfers.find((x) => x.id === c.id);
    switch (c.t) {
      case 'offer': {
        const l = this.links.get(peerId);
        const total = c.files.reduce((n, f) => n + f.size, 0);
        this.set({
          transfers: [
            {
              id: c.id, peerId, peerName: c.name, direction: 'in', files: c.files, text: c.text, total, done: 0, speed: 0,
              status: 'asking', sas: l?.sas, route: l?.route, received: [], at: Date.now(),
            },
            ...this.state.transfers,
          ],
        });
        navigator.vibrate?.(80);
        break;
      }
      case 'accept':
        this.waiters.get(c.id)?.(true);
        break;
      case 'decline':
        this.waiters.get(c.id)?.(false);
        break;
      case 'cancel':
        if (t && !['done', 'declined'].includes(t.status)) {
          const o = this.outgoing.get(c.id);
          if (o) o.abort = true;
          this.incoming.delete(c.id);
          this.setTransfer(c.id, { status: 'cancelled' });
        }
        break;
      case 'end': {
        const inc = this.incoming.get(c.id);
        if (!t || !inc) break;
        let sink = inc.sinks.get(c.index);
        if (!sink) {
          // Empty file: no chunks were sent.
          sink = await createSink(t.files[c.index], `${t.id}-${c.index}`);
          inc.hashers.set(c.index, await Hasher.create());
        }
        const file = await sink.finish();
        const verified = inc.hashers.get(c.index)!.hex() === c.hash;
        inc.files[c.index] = { ...t.files[c.index], file, url: URL.createObjectURL(file), verified };
        this.setTransfer(c.id, { received: inc.files.filter((f): f is ReceivedFile => f !== null) });
        break;
      }
      case 'done': {
        const inc = this.incoming.get(c.id);
        if (!t || !inc) break;
        const allOk = inc.files.every((f) => f?.verified);
        this.setTransfer(c.id, { status: allOk ? 'done' : 'error', error: allOk ? undefined : 'checksum', done: t.total, speed: 0 });
        this.incoming.delete(c.id);
        break;
      }
    }
  }

  async respond(id: string, accept: boolean) {
    const t = this.state.transfers.find((x) => x.id === id);
    const l = t && this.links.get(t.peerId);
    if (!t || !l) return;
    if (accept) {
      this.incoming.set(id, { sinks: new Map(), hashers: new Map(), files: t.files.map(() => null), lastTick: performance.now(), lastBytes: 0 });
      this.setTransfer(id, { status: t.files.length ? 'receiving' : 'done' });
    } else this.setTransfer(id, { status: 'declined' });
    await l.send(controlFrame({ t: accept ? 'accept' : 'decline', id })).catch(() => {});
  }

  clearFinished() {
    for (const t of this.state.transfers) if (['done', 'declined', 'cancelled', 'error'].includes(t.status)) t.received.forEach((f) => URL.revokeObjectURL(f.url));
    this.set({ transfers: this.state.transfers.filter((t) => !['done', 'declined', 'cancelled', 'error'].includes(t.status)) });
  }
}

export const store = new Store();
export const useStore = () => useSyncExternalStore(store.subscribe, store.getSnapshot);
