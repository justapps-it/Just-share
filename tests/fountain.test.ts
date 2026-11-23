import { describe, expect, it } from 'vitest';
import { FountainDecoder, FountainEncoder } from '../src/lib/fountain';

function payload(n: number) {
  const p = new Uint8Array(n);
  for (let i = 0; i < n; i++) p[i] = (i * 31 + 7) & 255;
  return p;
}

describe('fountain code', () => {
  it('decodes from the start, in order', () => {
    const p = payload(10_000);
    const enc = new FountainEncoder(p, 600, 42);
    const dec = new FountainDecoder();
    let seq = 0;
    while (!dec.done) dec.add(enc.frame(seq++));
    expect(dec.result()).toEqual(p);
    expect(seq).toBeLessThan(enc.k * 2 + 2);
  });

  it('survives joining late and losing 40% of frames', () => {
    const p = payload(50_000);
    const enc = new FountainEncoder(p, 700, 7);
    const dec = new FountainDecoder();
    let seq = 123; // joined in the middle
    let shown = 0;
    let rnd = 1;
    while (!dec.done && shown < 5000) {
      rnd = (rnd * 16807) % 2147483647;
      if (rnd % 10 >= 4) dec.add(enc.frame(seq));
      seq++;
      shown++;
    }
    expect(dec.done).toBe(true);
    expect(dec.result()).toEqual(p);
    // Efficiency: frames received vs. blocks needed.
    expect(dec.frames / enc.k).toBeLessThan(1.6);
  });

  it('resets when a new transfer starts', () => {
    const a = new FountainEncoder(payload(3000), 500, 1);
    const b = new FountainEncoder(payload(2000), 500, 2);
    const dec = new FountainDecoder();
    dec.add(a.frame(0));
    let seq = 0;
    while (!dec.done) dec.add(b.frame(seq++));
    expect(dec.result()).toEqual(payload(2000));
  });

  it('rejects foreign QR codes', () => {
    const dec = new FountainDecoder();
    expect(dec.add(new TextEncoder().encode('https://example.com'))).toBe(false);
  });
});
