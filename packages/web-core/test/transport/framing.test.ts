import { loadVectors, vectorsDir } from "@zakadi/protocol/vectors";
import { describe, expect, it } from "vitest";
import {
  AUDIO,
  BATCH,
  pack,
  packBatch,
  packProbe,
  VIDEO,
  type Header,
} from "../../src/transport/framing";
import { builtin } from "./node";
import { FramingError, fromHex, readMessage, readProbe, toHex } from "./read";

const { readFileSync } = builtin<{ readFileSync(path: string): Uint8Array }>(
  "node:fs",
);

// spec/01-protocol.md 1.3.1 and 1.3.2 against framing/*.json and *.bin of the pinned
// protocol release.
const cases = loadVectors().framing;
const valid = cases.filter((c) => c.expect);
const invalid = cases.filter((c) => c.error);
const bin = (name: string) =>
  new Uint8Array(readFileSync(`${vectorsDir()}/framing/${name}.bin`));

describe("framing vectors", () => {
  it("has valid and invalid cases", () => {
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
  });

  it.each(valid)("$name decodes to its header and payload", (c) => {
    const m = readMessage(fromHex(c.hex));
    const e = c.expect!;
    expect(m.header).toEqual(e.header);
    expect(toHex(m.payload)).toBe(e.payload_hex);
    if (e.probe_send_time_us !== undefined)
      expect(m.probe).toBe(e.probe_send_time_us);
    if (e.audio_batch)
      expect(
        m.batch!.map((r) => ({
          pts_delta_ms: r.pts_delta_ms,
          packet_hex: toHex(r.packet),
        })),
      ).toEqual(e.audio_batch);
  });

  it.each(invalid)("$name fails with $error", (c) => {
    expect(() => readMessage(fromHex(c.hex))).toThrow(FramingError);
    try {
      readMessage(fromHex(c.hex));
    } catch (err) {
      expect((err as FramingError).code).toBe(c.error);
    }
  });

  it.each(valid)("the writers reproduce $name.bin", (c) => {
    const e = c.expect!;
    const file = bin(c.name);
    expect(toHex(file)).toBe(c.hex);
    const h: Header = {
      key: e.header.keyframe,
      ps: e.header.param_sets,
      rc: e.header.rung_changed,
      rung: e.header.rung,
      seq: e.header.seq,
      pts: e.header.pts_ms,
    };
    const payload = fromHex(e.payload_hex);
    let out: Uint8Array;
    switch (e.header.type) {
      case VIDEO:
      case AUDIO:
        out = new Uint8Array(pack(e.header.type, h, payload));
        break;
      case BATCH:
        out = new Uint8Array(
          packBatch(
            h,
            e.audio_batch!.map((r) => ({
              ts: e.header.pts_ms + r.pts_delta_ms,
              data: fromHex(r.packet_hex),
            })),
          ),
        );
        break;
      default: {
        // A probe: header and send time exactly, then random fill of the same length.
        out = new Uint8Array(
          packProbe(file.byteLength, e.header.seq, e.probe_send_time_us!),
        );
        expect(out.byteLength).toBe(file.byteLength);
        expect(toHex(out.subarray(0, 16))).toBe(toHex(file.subarray(0, 16)));
        return;
      }
    }
    expect(toHex(out)).toBe(toHex(file));
  });

  it("writes a video prefix before the access unit", () => {
    const h = { key: true, ps: true, rung: 2, seq: 1042, pts: 8420 };
    const c = valid.find((x) => x.name === "video-idr-with-params")!;
    const payload = fromHex(c.expect!.payload_hex);
    // The SPS and PPS NAL units as a prefix, the IDR slice as the body.
    const split = c.expect!.payload_hex.indexOf("0000000165") / 2;
    expect(
      toHex(
        new Uint8Array(
          pack(VIDEO, h, payload.subarray(0, split), payload.subarray(split)),
        ),
      ),
    ).toBe(c.hex);
  });

  it("wraps seq and pts and fills a probe up to its size", () => {
    const a = readMessage(
      new Uint8Array(
        pack(
          AUDIO,
          { rung: 4, seq: 65536 + 7, pts: 2 ** 32 + 5 },
          new Uint8Array(3),
        ),
      ),
    );
    expect(a.header).toMatchObject({ type: 1, rung: 4, seq: 7, pts_ms: 5 });
    const p = new Uint8Array(packProbe(70000, 3, 2 ** 40 + 9));
    expect(p.byteLength).toBe(70000);
    expect(readMessage(p).header).toMatchObject({
      type: 2,
      rung: 0,
      seq: 3,
      pts_ms: 0,
    });
    expect(readProbe(p.subarray(8))).toBe(2 ** 40 + 9);
    expect(p.subarray(65552).some((x) => x !== 0)).toBe(true);
  });
});
