// Fountain code (Luby Transform) for the offline camera mode.
//
// The sender shows an endless sequence of QR frames. Each frame carries
// either one block of the payload or the XOR of a few random blocks. The
// receiver can start watching at any moment and miss frames: once it has
// collected slightly more frames than blocks, a "peeling" decoder rebuilds
// everything. No back channel is needed, so it works fully offline.

const MAGIC0 = 0x4a; // 'J'
const MAGIC1 = 0x53; // 'S'
const VERSION = 1;
export const HEADER = 18;

/** Small, fast, deterministic PRNG (both sides generate the same choices). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Robust soliton degree distribution (cumulative), cached per K. */
const cdfCache = new Map<number, Float64Array>();
function degreeCdf(k: number): Float64Array {
  let cdf = cdfCache.get(k);
  if (cdf) return cdf;
  const c = 0.1;
  const delta = 0.5;
  const R = c * Math.log(k / delta) * Math.sqrt(k);
  const pivot = Math.max(1, Math.min(k, Math.floor(k / R)));
  const p = new Float64Array(k + 1);
  p[1] = 1 / k;
  for (let d = 2; d <= k; d++) p[d] = 1 / (d * (d - 1));
  for (let d = 1; d < pivot; d++) p[d] += R / (d * k);
  if (pivot <= k) p[pivot] += (R * Math.log(R / delta)) / k;
  let sum = 0;
  for (let d = 1; d <= k; d++) sum += p[d];
  cdf = new Float64Array(k + 1);
  let acc = 0;
  for (let d = 1; d <= k; d++) {
    acc += p[d] / sum;
    cdf[d] = acc;
  }
  cdfCache.set(k, cdf);
  return cdf;
}

/** Which source blocks are combined in frame `seq`. */
export function blocksFor(seq: number, k: number, session: number): number[] {
  // Even frames are plain blocks (fast start, cheap decoding), odd frames are
  // random combinations (they fill whatever the receiver missed).
  if (seq % 2 === 0 || k === 1) return [(seq >>> 1) % k];
  const rand = mulberry32((seq * 2654435761) ^ session);
  const cdf = degreeCdf(k);
  const r = rand();
  let d = 1;
  while (d < k && cdf[d] < r) d++;
  const chosen = new Set<number>();
  while (chosen.size < d) chosen.add(Math.floor(rand() * k));
  return [...chosen];
}

export class FountainEncoder {
  readonly k: number;
  readonly session: number;
  private blocks: Uint8Array[];

  constructor(
    private payload: Uint8Array,
    readonly blockSize: number,
    session?: number,
  ) {
    this.k = Math.max(1, Math.ceil(payload.length / blockSize));
    this.session = session ?? crypto.getRandomValues(new Uint32Array(1))[0];
    this.blocks = Array.from({ length: this.k }, (_, i) => {
      const b = new Uint8Array(blockSize);
      b.set(payload.subarray(i * blockSize, (i + 1) * blockSize));
      return b;
    });
  }

  frame(seq: number): Uint8Array {
    const out = new Uint8Array(HEADER + this.blockSize);
    const v = new DataView(out.buffer);
    out[0] = MAGIC0;
    out[1] = MAGIC1;
    out[2] = VERSION;
    out[3] = 0;
    v.setUint32(4, this.session);
    v.setUint32(8, this.payload.length);
    v.setUint16(12, this.blockSize);
    v.setUint32(14, seq);
    const data = out.subarray(HEADER);
    for (const i of blocksFor(seq, this.k, this.session)) {
      const b = this.blocks[i];
      for (let j = 0; j < b.length; j++) data[j] ^= b[j];
    }
    return out;
  }
}

export interface FrameHeader {
  session: number;
  length: number;
  blockSize: number;
  seq: number;
}

export function parseFrame(f: Uint8Array): FrameHeader | null {
  if (f.length < HEADER || f[0] !== MAGIC0 || f[1] !== MAGIC1 || f[2] !== VERSION) return null;
  const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
  const h = { session: v.getUint32(4), length: v.getUint32(8), blockSize: v.getUint16(12), seq: v.getUint32(14) };
  if (!h.blockSize || f.length !== HEADER + h.blockSize) return null;
  return h;
}

/** Peeling (belief propagation) decoder. */
export class FountainDecoder {
  session: number | null = null;
  length = 0;
  blockSize = 0;
  k = 0;
  private known: (Uint8Array | null)[] = [];
  private solved = 0;
  private pending: { idx: Set<number>; data: Uint8Array }[] = [];
  private seen = new Set<number>();
  frames = 0;

  /** Returns true when the frame was new and useful information was added. */
  add(frame: Uint8Array): boolean {
    const h = parseFrame(frame);
    if (!h) return false;
    if (this.session === null || h.session !== this.session) {
      // First frame, or the sender started a new transfer: reset.
      this.session = h.session;
      this.length = h.length;
      this.blockSize = h.blockSize;
      this.k = Math.max(1, Math.ceil(h.length / h.blockSize));
      this.known = new Array(this.k).fill(null);
      this.solved = 0;
      this.pending = [];
      this.seen.clear();
      this.frames = 0;
    }
    if (this.seen.has(h.seq)) return false;
    this.seen.add(h.seq);
    this.frames++;
    const data = frame.slice(18);
    const idx = new Set(blocksFor(h.seq, this.k, h.session));
    this.reduce(idx, data);
    if (idx.size === 0) return false;
    if (idx.size === 1) this.solve([...idx][0], data);
    else this.pending.push({ idx, data });
    return true;
  }

  private reduce(idx: Set<number>, data: Uint8Array) {
    for (const i of [...idx]) {
      const b = this.known[i];
      if (!b) continue;
      for (let j = 0; j < data.length; j++) data[j] ^= b[j];
      idx.delete(i);
    }
  }

  private solve(i: number, data: Uint8Array) {
    const stack: [number, Uint8Array][] = [[i, data]];
    while (stack.length) {
      const [bi, bd] = stack.pop()!;
      if (this.known[bi]) continue;
      this.known[bi] = bd;
      this.solved++;
      const rest: typeof this.pending = [];
      for (const eq of this.pending) {
        if (eq.idx.has(bi)) {
          for (let j = 0; j < bd.length; j++) eq.data[j] ^= bd[j];
          eq.idx.delete(bi);
        }
        if (eq.idx.size === 1) stack.push([[...eq.idx][0], eq.data]);
        else if (eq.idx.size > 1) rest.push(eq);
      }
      this.pending = rest;
    }
  }

  get progress(): number {
    return this.k ? this.solved / this.k : 0;
  }

  get done(): boolean {
    return this.k > 0 && this.solved === this.k;
  }

  result(): Uint8Array {
    const out = new Uint8Array(this.length);
    this.known.forEach((b, i) => b && out.set(b.subarray(0, Math.min(this.blockSize, this.length - i * this.blockSize)), i * this.blockSize));
    return out;
  }
}
