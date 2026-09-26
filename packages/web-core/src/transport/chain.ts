import type { AttestMsg } from "@zakadi/protocol";

const sha = (d: Uint8Array<ArrayBuffer>) => crypto.subtle.digest("SHA-256", d);

const cat = (a: Uint8Array, b: Uint8Array) => {
  const r = new Uint8Array(a.byteLength + b.byteLength);
  r.set(a);
  r.set(b, a.byteLength);
  return r;
};

/** Lowercase hex. */
export const hex = (b: ArrayBuffer): string =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join(
    "",
  );

/**
 * The hash chain `attest` reports (spec/01-protocol.md 1.4, spec/06-web-sdk.md 6.2.6):
 * H0 = SHA-256(utf8(session_id) || jti_bytes), then Hn = SHA-256(Hn-1 || header8 ||
 * payload) for every message of type 0, 1 or 3 in send order, through a FIFO promise
 * queue on crypto.subtle.digest. Probes are not chained.
 */
export class Chain {
  private q: Promise<ArrayBuffer>;
  // The seq of the last chained video and audio message (0 before any).
  private v = 0;
  private a = 0;

  constructor(sessionId: string, jti: Uint8Array) {
    this.q = sha(cat(new TextEncoder().encode(sessionId), jti));
  }

  /** Chains one media message, as sent; a probe is skipped. */
  feed(msg: ArrayBuffer): void {
    const u8 = new Uint8Array(msg);
    const type = (u8[0]! >> 4) & 3;
    const seq = u8[2]! | (u8[3]! << 8);
    if (type !== 2)
      this.q = this.q.then((h) => {
        if (type) this.a = seq;
        else this.v = seq;
        return sha(cat(new Uint8Array(h), u8));
      });
  }

  /** The `attest` message for every message fed so far, once their digests are done. */
  attest(): Promise<AttestMsg> {
    return this.q.then((h) => ({
      t: "attest",
      video_seq: this.v,
      audio_seq: this.a,
      chain: hex(h),
    }));
  }
}
