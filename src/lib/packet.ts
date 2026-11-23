// What travels in the offline camera mode: files and/or text, compressed
// when it helps, with a BLAKE2b checksum.
import { deflateSync, inflateSync } from 'fflate';
import { hashHex } from './crypto';

export interface PacketMeta {
  files: { name: string; size: number; type: string }[];
  text?: string;
  hash: string;
}

const COMPRESSED = 1;

export async function pack(files: File[], text?: string): Promise<Uint8Array> {
  const datas = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
  const body = new Uint8Array(datas.reduce((n, d) => n + d.length, 0));
  let off = 0;
  for (const d of datas) {
    body.set(d, off);
    off += d.length;
  }
  const meta: PacketMeta = {
    files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
    text: text || undefined,
    hash: await hashHex(body),
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const raw = new Uint8Array(4 + metaBytes.length + body.length);
  new DataView(raw.buffer).setUint32(0, metaBytes.length);
  raw.set(metaBytes, 4);
  raw.set(body, 4 + metaBytes.length);
  // Photos and videos don't compress: only keep the deflated copy if it's smaller.
  const deflated = deflateSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length * 0.95;
  const content = useDeflate ? deflated : raw;
  const out = new Uint8Array(content.length + 1);
  out[0] = useDeflate ? COMPRESSED : 0;
  out.set(content, 1);
  return out;
}

export interface Unpacked {
  meta: PacketMeta;
  files: File[];
  verified: boolean;
}

export async function unpack(payload: Uint8Array): Promise<Unpacked> {
  const raw = payload[0] & COMPRESSED ? inflateSync(payload.subarray(1)) : payload.subarray(1);
  const metaLen = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0);
  const meta = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + metaLen))) as PacketMeta;
  const body = raw.subarray(4 + metaLen);
  let off = 0;
  const files = meta.files.map((f) => {
    const file = new File([body.slice(off, off + f.size)], f.name, { type: f.type || 'application/octet-stream' });
    off += f.size;
    return file;
  });
  return { meta, files, verified: (await hashHex(body)) === meta.hash };
}
