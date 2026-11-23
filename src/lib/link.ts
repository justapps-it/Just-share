// A direct, end-to-end encrypted channel to one device (WebRTC data channel).
//
// Negotiation follows the "perfect negotiation" pattern (both sides may
// start). Once the data channel opens, each side sends a fresh X25519 public
// key; every later frame is sealed with XChaCha20-Poly1305 (see crypto.ts).
import { deriveSession, fromB64, newKeyPair, toB64, type KeyPair, type Session } from './crypto';

type SignalData = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };

let iceCache: Promise<RTCIceServer[]> | undefined;
export function iceServers(): Promise<RTCIceServer[]> {
  iceCache ??= fetch('/api/ice')
    .then((r) => r.json())
    .then((r: { iceServers: RTCIceServer[] }) => r.iceServers)
    .catch(() => [{ urls: 'stun:stun.cloudflare.com:3478' }]);
  return iceCache;
}

const HELLO = 0xff;
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

export type LinkState = 'connecting' | 'open' | 'closed' | 'failed';

export class Link {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel;
  private polite: boolean;
  private makingOffer = false;
  private ignoreOffer = false;
  private keys?: KeyPair;
  private session?: Session;
  private sessionWaiters: ((s: Session) => void)[] = [];
  private pendingHello?: Uint8Array;
  state: LinkState = 'connecting';
  /** "direct" (same network), "internet" (peer-to-peer over the internet) or "relay". */
  route: 'direct' | 'internet' | 'relay' | null = null;

  constructor(
    private myId: string,
    public peerId: string,
    servers: RTCIceServer[],
    private sendSignal: (data: SignalData) => void,
    private onFrame: (plain: Uint8Array) => void,
    private onState: (s: LinkState) => void,
  ) {
    this.polite = myId > peerId;
    this.pc = new RTCPeerConnection({ iceServers: servers });
    // Pre-negotiated channel: no race about who creates it.
    this.dc = this.pc.createDataChannel('justshare', { negotiated: true, id: 0, ordered: true });
    this.dc.binaryType = 'arraybuffer';
    this.dc.bufferedAmountLowThreshold = LOW_WATER;
    this.dc.onopen = () => void this.hello();
    this.dc.onclose = () => this.setState('closed');
    this.dc.onmessage = (e) => void this.receive(new Uint8Array(e.data as ArrayBuffer));

    this.pc.onicecandidate = ({ candidate }) => this.sendSignal({ candidate: candidate?.toJSON() ?? null });
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.sendSignal({ description: this.pc.localDescription!.toJSON() });
      } catch {
        /* retried by the other side */
      } finally {
        this.makingOffer = false;
      }
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed') this.setState('failed');
      if (s === 'closed') this.setState('closed');
      if (s === 'connected') void this.detectRoute();
    };
  }

  private setState(s: LinkState) {
    if (this.state === s) return;
    this.state = s;
    this.onState(s);
  }

  async handleSignal(data: SignalData) {
    try {
      if (data.description) {
        const d = data.description;
        const collision = d.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          await this.pc.setLocalDescription();
          this.sendSignal({ description: this.pc.localDescription!.toJSON() });
        }
      } else if (data.candidate !== undefined) {
        try {
          await this.pc.addIceCandidate(data.candidate ?? undefined);
        } catch (e) {
          if (!this.ignoreOffer) throw e;
        }
      }
    } catch {
      /* a later signal will fix it, or the link times out */
    }
  }

  private async hello() {
    this.keys = await newKeyPair();
    const pk = new TextEncoder().encode(await toB64(this.keys.publicKey));
    const frame = new Uint8Array(pk.length + 1);
    frame[0] = HELLO;
    frame.set(pk, 1);
    this.dc.send(frame);
    if (this.pendingHello) void this.receive(this.pendingHello);
  }

  private async receive(frame: Uint8Array) {
    if (frame[0] === HELLO && !this.session) {
      if (!this.keys) {
        this.pendingHello = frame;
        return;
      }
      const theirs = await fromB64(new TextDecoder().decode(frame.subarray(1)));
      this.session = await deriveSession(this.keys, theirs, this.myId < this.peerId);
      this.sessionWaiters.forEach((w) => w(this.session!));
      this.sessionWaiters = [];
      this.setState('open');
      return;
    }
    if (!this.session) return;
    let plain: Uint8Array;
    try {
      plain = this.session.open(frame);
    } catch {
      return; // tampered or corrupted: drop
    }
    this.onFrame(plain);
  }

  /** Resolves when the encrypted channel is ready; also gives the verification code. */
  ready(timeoutMs = 25_000): Promise<Session> {
    if (this.session) return Promise.resolve(this.session);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect_timeout')), timeoutMs);
      this.sessionWaiters.push((s) => {
        clearTimeout(t);
        resolve(s);
      });
    });
  }

  get sas() {
    return this.session?.sas;
  }

  /** Sends one encrypted frame, waiting if the channel buffer is full. */
  async send(plain: Uint8Array) {
    if (!this.session) await this.ready();
    if (this.dc.bufferedAmount > HIGH_WATER) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.dc.removeEventListener('bufferedamountlow', done);
          this.dc.removeEventListener('close', done);
          resolve();
        };
        this.dc.addEventListener('bufferedamountlow', done);
        this.dc.addEventListener('close', done);
      });
    }
    if (this.dc.readyState !== 'open') throw new Error('link_closed');
    this.dc.send(this.session!.seal(plain) as Uint8Array<ArrayBuffer>);
  }

  /** Waits until everything queued has left this device. */
  async drain() {
    while (this.dc.readyState === 'open' && this.dc.bufferedAmount > 0) await new Promise((r) => setTimeout(r, 50));
  }

  private async detectRoute() {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | undefined;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      let pair: RTCIceCandidatePairStats | undefined;
      stats.forEach((r) => {
        if ((pairId && r.id === pairId) || (!pairId && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded')) pair = r as RTCIceCandidatePairStats;
      });
      if (!pair) return;
      const local = stats.get(pair.localCandidateId) as { candidateType?: string } | undefined;
      const remote = stats.get(pair.remoteCandidateId) as { candidateType?: string } | undefined;
      const types = [local?.candidateType, remote?.candidateType];
      this.route = types.includes('relay') ? 'relay' : types.every((t) => t === 'host') ? 'direct' : 'internet';
      this.onState(this.state);
    } catch {
      /* stats unsupported */
    }
  }

  close() {
    this.dc.close();
    this.pc.close();
    this.setState('closed');
  }
}
