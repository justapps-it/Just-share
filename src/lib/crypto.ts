// End-to-end encryption and checksums with libsodium (WebAssembly).
//  - X25519 key exchange (crypto_kx) per connection, fresh keys every time
//  - XChaCha20-Poly1305 for every message
//  - BLAKE2b-256 checksum of every file
//  - a 6-digit verification code both screens show (from the public keys)
import _sodium from 'libsodium-wrappers';

export type Sodium = typeof _sodium;
let ready: Promise<Sodium> | undefined;
export const sodium = () => (ready ??= _sodium.ready.then(() => _sodium));

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface Session {
  /** Encrypts a frame: [24-byte nonce][ciphertext+tag]. */
  seal(plain: Uint8Array): Uint8Array;
  open(frame: Uint8Array): Uint8Array;
  /** Short code to compare on both screens. */
  sas: string;
}

export async function newKeyPair(): Promise<KeyPair> {
  const s = await sodium();
  return s.crypto_kx_keypair();
}

/** `initiator` is decided by comparing device ids, so both sides agree. */
export async function deriveSession(me: KeyPair, theirPublic: Uint8Array, initiator: boolean): Promise<Session> {
  const s = await sodium();
  const keys = initiator
    ? s.crypto_kx_client_session_keys(me.publicKey, me.privateKey, theirPublic)
    : s.crypto_kx_server_session_keys(me.publicKey, me.privateKey, theirPublic);
  const [a, b] = initiator ? [me.publicKey, theirPublic] : [theirPublic, me.publicKey];
  const transcript = new Uint8Array(a.length + b.length);
  transcript.set(a);
  transcript.set(b, a.length);
  const h = s.crypto_generichash(8, transcript, null);
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  const sas = String(n % 1_000_000).padStart(6, '0');
  const NB = s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  return {
    sas: `${sas.slice(0, 3)} ${sas.slice(3)}`,
    seal(plain) {
      const nonce = s.randombytes_buf(NB);
      const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, null, null, nonce, keys.sharedTx);
      const out = new Uint8Array(NB + ct.length);
      out.set(nonce);
      out.set(ct, NB);
      return out;
    },
    open(frame) {
      return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, frame.subarray(NB), null, frame.subarray(0, NB), keys.sharedRx);
    },
  };
}

/** Streaming BLAKE2b-256. */
export class Hasher {
  private state: unknown;
  private constructor(private s: Sodium) {
    this.state = s.crypto_generichash_init(null, 32);
  }
  static async create() {
    return new Hasher(await sodium());
  }
  update(data: Uint8Array) {
    this.s.crypto_generichash_update(this.state as never, data);
  }
  hex(): string {
    return this.s.to_hex(this.s.crypto_generichash_final(this.state as never, 32));
  }
}

export async function hashHex(data: Uint8Array): Promise<string> {
  const s = await sodium();
  return s.to_hex(s.crypto_generichash(32, data, null));
}

export const toB64 = async (b: Uint8Array) => (await sodium()).to_base64(b, _sodium.base64_variants.URLSAFE_NO_PADDING);
export const fromB64 = async (t: string) => (await sodium()).from_base64(t, _sodium.base64_variants.URLSAFE_NO_PADDING);
