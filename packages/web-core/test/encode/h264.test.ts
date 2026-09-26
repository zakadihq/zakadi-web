import { describe, expect, it } from "vitest";
import { avcc, codecOf, join, nals, unit } from "../../src/encode/h264.js";
import {
  IDR,
  PPS,
  SLICE,
  annexB,
  avccRecord,
  concat,
  lengthPrefixed,
  sps,
} from "./fakes.js";

// spec/06-web-sdk.md 6.2.4 and spec/01-protocol.md 1.3.2: access units as the wire carries them.
describe("H.264 access units", () => {
  it("split Annex-B on 3- and 4-byte start codes and length-prefixed units on their lengths", () => {
    const mixed = concat([
      Uint8Array.of(0, 0, 1),
      SLICE,
      Uint8Array.of(0, 0, 0, 1),
      IDR,
    ]);
    expect(nals(mixed, 0)).toEqual([SLICE, IDR]);
    expect(nals(lengthPrefixed(sps(), PPS, IDR), 4)).toEqual([sps(), PPS, IDR]);
    expect(join([SLICE, IDR])).toEqual(annexB(SLICE, IDR));
  });

  it("report the profile, constraint flags and level of an SPS as the codec", () => {
    expect(codecOf(sps())).toBe("avc1.42E01F");
    expect(codecOf(sps(0x1e, 0x42, 0xc0))).toBe("avc1.42C01E");
    expect(codecOf(sps(0x28, 0x4d, 0x40))).toBe("avc1.4D4028");
  });

  it("read the NAL length size, SPS and PPS of an avcC record", () => {
    expect(avcc(avccRecord(sps(), PPS))).toEqual([4, [sps(), PPS]]);
  });

  it("flag an IDR with its SPS and PPS and cache them", () => {
    const cache: { sets?: Uint8Array[] | undefined } = {};
    const u = unit(annexB(sps(), PPS, IDR), 0, cache);
    expect(u).toEqual({
      data: annexB(sps(), PPS, IDR),
      key: true,
      ps: true,
      sps: sps(),
    });
    expect(cache.sets).toEqual([sps(), PPS]);
  });

  it("prepend the cached SPS and PPS to an IDR without them, and set param_sets", () => {
    const cache = { sets: [sps(0x1e), PPS] };
    expect(unit(annexB(IDR), 0, cache)).toEqual({
      data: annexB(sps(0x1e), PPS, IDR),
      key: true,
      ps: true,
      sps: sps(0x1e),
    });
  });

  it("leave a non-IDR unit alone and clear param_sets when the sets follow the slices", () => {
    const cache = { sets: [sps(), PPS] };
    expect(unit(annexB(SLICE), 0, cache)).toEqual({
      data: annexB(SLICE),
      key: false,
      ps: false,
      sps: undefined,
    });
    expect(unit(annexB(SLICE, sps(), PPS), 0, {}).ps).toBe(false);
  });

  it("rewrite length-prefixed (avcC) units to 4-byte start codes", () => {
    const cache = { sets: [sps(), PPS] };
    expect(unit(lengthPrefixed(IDR), 4, cache).data).toEqual(
      annexB(sps(), PPS, IDR),
    );
    expect(unit(lengthPrefixed(SLICE), 4, cache).data).toEqual(annexB(SLICE));
  });
});
