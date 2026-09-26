import type { FramingHeader } from "@zakadi/protocol/vectors";

// Readers for binary media messages (spec/01-protocol.md 1.3.1 and 1.3.2), for the tests:
// the client only writes them. Errors carry the codes of the framing vectors.

export class FramingError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const view = (b: Uint8Array) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength);

export function readHeader(b: Uint8Array): FramingHeader {
  if (b.byteLength < 8) throw new FramingError("short_header");
  const b0 = b[0]!;
  const b1 = b[1]!;
  if (b0 >> 6) throw new FramingError("unsupported_version");
  if (b0 & 1) throw new FramingError("reserved_bit_set");
  if (b1 & 15) throw new FramingError("reserved_bits_set");
  const dv = view(b);
  return {
    ver: 0,
    type: (b0 >> 4) & 3,
    keyframe: !!(b0 & 8),
    param_sets: !!(b0 & 4),
    rung_changed: !!(b0 & 2),
    rung: b1 >> 4,
    seq: dv.getUint16(2, true),
    pts_ms: dv.getUint32(4, true),
  };
}

/** A probe payload's send time in microseconds (uint64 little-endian). */
export function readProbe(payload: Uint8Array): number {
  if (payload.byteLength < 8) throw new FramingError("short_probe");
  const dv = view(payload);
  return dv.getUint32(0, true) + dv.getUint32(4, true) * 2 ** 32;
}

/** An audio_batch payload's records, which must be ordered by pts_delta_ms. */
export function readBatch(
  payload: Uint8Array,
): { pts_delta_ms: number; packet: Uint8Array }[] {
  const dv = view(payload);
  const out: { pts_delta_ms: number; packet: Uint8Array }[] = [];
  let pos = 0;
  let last = -1;
  while (pos < payload.byteLength) {
    if (payload.byteLength - pos < 4)
      throw new FramingError("truncated_batch_record");
    const len = dv.getUint16(pos, true);
    const delta = dv.getUint16(pos + 2, true);
    pos += 4;
    if (payload.byteLength - pos < len)
      throw new FramingError("truncated_batch_record");
    if (delta < last) throw new FramingError("batch_out_of_order");
    out.push({ pts_delta_ms: delta, packet: payload.subarray(pos, pos + len) });
    pos += len;
    last = delta;
  }
  if (!out.length) throw new FramingError("empty_batch");
  return out;
}

/** One media message: its header, payload and the payload fields of its type. */
export function readMessage(b: Uint8Array) {
  const header = readHeader(b);
  const payload = b.subarray(8);
  return {
    header,
    payload,
    probe: header.type === 2 ? readProbe(payload) : undefined,
    batch: header.type === 3 ? readBatch(payload) : undefined,
  };
}

export const fromHex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

export const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** base64url without padding, as the jti claim and the vectors carry it. */
export const fromBase64url = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
