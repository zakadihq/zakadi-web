// H.264 access units as spec/01-protocol.md 1.3.2 carries them: Annex-B with 4-byte start
// codes, SPS and PPS ahead of the slices of every IDR (spec/06-web-sdk.md 6.2.4).

/** The NAL units of an access unit, without start codes or length prefixes. */
export function nals(b: Uint8Array, lengthSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (lengthSize) {
    // avcC: each NAL unit follows its big-endian length.
    for (let i = 0; i + lengthSize <= b.length;) {
      let n = 0;
      for (const end = i + lengthSize; i < end; i++) n = n * 256 + b[i]!;
      out.push(b.subarray(i, (i += n)));
    }
    return out;
  }
  let from = -1;
  for (let i = 2; i < b.length; i++) {
    if (b[i] === 1 && b[i - 1] === 0 && b[i - 2] === 0) {
      if (from >= 0) out.push(trim(b, from, i - 2));
      from = i + 1;
    }
  }
  if (from >= 0) out.push(trim(b, from, b.length));
  return out;
}

// A 4-byte start code leaves its first zero at the end of the NAL unit before it.
function trim(b: Uint8Array, from: number, to: number): Uint8Array {
  while (to > from && b[to - 1] === 0) to--;
  return b.subarray(from, to);
}

/** NAL units joined with 4-byte start codes. */
export function join(units: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(units.reduce((n, u) => n + 4 + u.length, 0));
  let at = 0;
  for (const u of units) {
    out[at + 3] = 1;
    out.set(u, at + 4);
    at += 4 + u.length;
  }
  return out;
}

/** The NAL length size and the SPS and PPS units of an avcC record (ISO/IEC 14496-15). */
export function avcc(d: Uint8Array): [number, Uint8Array[]] {
  const sets: Uint8Array[] = [];
  let i = 5;
  for (const mask of [0x1f, 0xff]) {
    for (let n = d[i++]! & mask; n > 0; n--) {
      const size = (d[i]! << 8) | d[i + 1]!;
      sets.push(d.subarray(i + 2, (i += 2 + size)));
    }
  }
  return [(d[4]! & 3) + 1, sets];
}

/**
 * `avc1.` and the profile, constraint flags and level of an SPS unit, in hex. The three
 * bytes after the SPS NAL header sit at the same offsets as in an avcC record.
 */
export function codecOf(sps: Uint8Array): string {
  let hex = "";
  for (let i = 1; i < 4; i++) hex += (sps[i]! | 0x100).toString(16).slice(1);
  return "avc1." + hex.toUpperCase();
}

/** An access unit ready for a type 0 message, with its header flags (1.3.1). */
export interface Unit {
  data: Uint8Array;
  /** An IDR (NAL type 5) is present. */
  key: boolean;
  /** SPS and PPS precede the slices. */
  ps: boolean;
  /** The first SPS of the unit. */
  sps: Uint8Array | undefined;
}

/**
 * Rewrites an access unit to Annex-B. SPS and PPS ahead of its slices replace `cache.sets`;
 * an IDR without them gets the cached ones prepended.
 */
export function unit(
  b: Uint8Array,
  lengthSize: number,
  cache: { sets?: Uint8Array[] | undefined },
): Unit {
  let units = nals(b, lengthSize);
  const types = units.map((u) => u[0]! & 0x1f);
  const slice = types.findIndex((t) => t > 0 && t < 6);
  const before = (t: number): boolean => {
    const i = types.indexOf(t);
    return i >= 0 && (slice < 0 || i < slice);
  };
  const key = types.includes(5);
  let ps = before(7) && before(8);
  if (ps) cache.sets = [units[types.indexOf(7)]!, units[types.indexOf(8)]!];
  else if (key && cache.sets) {
    units = [...cache.sets, ...units];
    ps = true;
  }
  return {
    data: join(units),
    key,
    ps,
    sps: units.find((u) => (u[0]! & 0x1f) === 7),
  };
}
