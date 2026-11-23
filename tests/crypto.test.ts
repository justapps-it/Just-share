import { describe, expect, it } from 'vitest';
import { deriveSession, Hasher, hashHex, newKeyPair } from '../src/lib/crypto';
import { pack, unpack } from '../src/lib/packet';

describe('end-to-end crypto', () => {
  it('both sides derive matching keys and the same verification code', async () => {
    const a = await newKeyPair();
    const b = await newKeyPair();
    const sa = await deriveSession(a, b.publicKey, true);
    const sb = await deriveSession(b, a.publicKey, false);
    expect(sa.sas).toBe(sb.sas);
    expect(sa.sas).toMatch(/^\d{3} \d{3}$/);
    const msg = new TextEncoder().encode('ciao dal telefono');
    expect(new TextDecoder().decode(sb.open(sa.seal(msg)))).toBe('ciao dal telefono');
    expect(new TextDecoder().decode(sa.open(sb.seal(msg)))).toBe('ciao dal telefono');
  });

  it('rejects tampered frames and a man in the middle shows a different code', async () => {
    const a = await newKeyPair();
    const b = await newKeyPair();
    const m = await newKeyPair();
    const sa = await deriveSession(a, b.publicKey, true);
    const sb = await deriveSession(b, a.publicKey, false);
    const frame = sa.seal(new Uint8Array([1, 2, 3]));
    frame[frame.length - 1] ^= 1;
    expect(() => sb.open(frame)).toThrow();
    const sm = await deriveSession(a, m.publicKey, true);
    expect(sm.sas).not.toBe(sb.sas);
  });

  it('streaming hash equals one-shot hash', async () => {
    const data = new Uint8Array(200_000).map((_, i) => i & 255);
    const h = await Hasher.create();
    h.update(data.subarray(0, 70_000));
    h.update(data.subarray(70_000));
    expect(h.hex()).toBe(await hashHex(data));
  });
});

describe('offline packets', () => {
  it('round-trips files and text, compressing when useful', async () => {
    const a = new File([new TextEncoder().encode('hello '.repeat(1000))], 'a.txt', { type: 'text/plain' });
    const b = new File([new Uint8Array([0, 1, 2, 255])], 'b.bin');
    const p = await pack([a, b], 'wifi: password123');
    expect(p[0]).toBe(1);
    expect(p.length).toBeLessThan(1000);
    const u = await unpack(p);
    expect(u.verified).toBe(true);
    expect(u.meta.text).toBe('wifi: password123');
    expect(u.files.map((f) => f.name)).toEqual(['a.txt', 'b.bin']);
    expect(new Uint8Array(await u.files[1].arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
  });
});
