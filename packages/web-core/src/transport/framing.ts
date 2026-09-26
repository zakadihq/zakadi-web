// Binary media message writers (spec/01-protocol.md 1.3.1 and 1.3.2, spec/06-web-sdk.md
// 6.2.6). Every message is its own exactly-sized ArrayBuffer, so the socket's
// bufferedAmount grows by exactly the message size.

/** Header types (1.3.1). */
export const VIDEO = 0;
export const AUDIO = 1;
export const PROBE = 2;
export const BATCH = 3;

/** The header fields a writer sets; absent flags are 0. */
export interface Header {
  key?: boolean | undefined;
  ps?: boolean | undefined;
  rc?: boolean | undefined;
  rung: number;
  seq: number;
  pts: number;
}

/** The 8-byte header: version 0, reserved bits 0, seq and pts little-endian, both wrapping. */
export function writeHeader(dv: DataView, type: number, h: Header): void {
  dv.setUint8(
    0,
    (type << 4) | (h.key ? 8 : 0) | (h.ps ? 4 : 0) | (h.rc ? 2 : 0),
  );
  dv.setUint8(1, (h.rung & 15) << 4);
  dv.setUint16(2, h.seq & 0xffff, true);
  dv.setUint32(4, h.pts >>> 0, true);
}

/** One media message: the header, then each part in order (a video prefix is the cached SPS and PPS). */
export function pack(
  type: number,
  h: Header,
  ...parts: Uint8Array[]
): ArrayBuffer {
  const buf = new ArrayBuffer(parts.reduce((n, p) => n + p.byteLength, 8));
  const u8 = new Uint8Array(buf);
  writeHeader(new DataView(buf), type, h);
  let at = 8;
  for (const p of parts) {
    u8.set(p, at);
    at += p.byteLength;
  }
  return buf;
}

/**
 * An `audio_batch` (type 3): one record `uint16 len | uint16 pts_delta_ms | packet` per
 * packet, little-endian, with deltas from the header pts, which is the first packet's.
 */
export function packBatch(
  h: Header,
  packets: { ts: number; data: Uint8Array }[],
): ArrayBuffer {
  return pack(
    BATCH,
    h,
    ...packets.flatMap((p) => {
      const r = new Uint8Array(4);
      const dv = new DataView(r.buffer);
      dv.setUint16(0, p.data.byteLength, true);
      dv.setUint16(2, p.ts - h.pts, true);
      return [r, p.data];
    }),
  );
}

/**
 * A probe (type 2) of `size` bytes, header included: rung 0 and pts 0 (G1), the send
 * time in microseconds as a little-endian uint64, then random bytes.
 */
export function packProbe(
  size: number,
  seq: number,
  sendUs: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  writeHeader(dv, PROBE, { rung: 0, seq, pts: 0 });
  dv.setUint32(8, sendUs % 2 ** 32, true);
  dv.setUint32(12, Math.floor(sendUs / 2 ** 32), true);
  // getRandomValues fills at most 65536 bytes per call.
  for (let i = 16; i < size; i += 65536)
    crypto.getRandomValues(new Uint8Array(buf, i, Math.min(65536, size - i)));
  return buf;
}
