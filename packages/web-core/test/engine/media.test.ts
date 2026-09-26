import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEncoder } from "../../src/encode/index";
import { adapt } from "../../src/engine/media";
import type { Chunk } from "../../src/transport/media";
import {
  FakeVideoEncoder,
  installFakes,
  removeFakes,
  settle,
} from "../encode/fakes";
import { at, camera, LADDER, READY } from "../encode/harness";

// The encoder-to-transport adapter (spec/06-web-sdk.md 6.2.4 to 6.2.7) over the real
// WebCodecs encoder of src/encode on its fakes: the transport's Media interface.
function setup() {
  const hooks = { t0: vi.fn(), error: vi.fn() };
  const media = adapt(
    (emit) =>
      createEncoder({
        video: { kind: "frames" },
        audio: { kind: "none" },
        emit,
      }),
    hooks,
  );
  const out: Chunk[] = [];
  const enc = () => FakeVideoEncoder.all[FakeVideoEncoder.all.length - 1]!;
  const feed = (from: number, to: number) => {
    for (let ms = from; ms < to; ms += 50) {
      at(ms + 5);
      media.pipeline.frame(camera(ms));
      enc().drain();
    }
  };
  return { media, hooks, out, enc, feed };
}

beforeEach(installFakes);
afterEach(removeFakes);

describe("adapt()", () => {
  it("passes chunks on in order with their flags, rung and pts", async () => {
    const { media, out, feed, hooks } = setup();
    media.pipeline.ready(READY);
    at(1000);
    media.start(LADDER[2]!, (c) => out.push(c));
    await settle();
    feed(1000, 1400);
    expect(hooks.t0).toHaveBeenCalledOnce();
    expect(media.origin()).toBe(hooks.t0.mock.calls[0]![0]);
    expect(out.length).toBeGreaterThan(2);
    expect(out[0]).toMatchObject({ key: true, ps: true, rung: 2 });
    expect(out[0]!.audio).toBeUndefined();
    expect(out[1]).toMatchObject({ key: false, rung: 2 });
    const ts = out.map((c) => c.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("describes the codec side of the last config a chunk carried", async () => {
    const { media, feed } = setup();
    media.pipeline.ready(READY);
    at(1000);
    media.start(LADDER[2]!, () => {});
    await settle();
    feed(1000, 1100);
    expect(media.describe()).toMatchObject({
      video: { codec: "avc1.42E01F", annexb: true, container: null },
      audio: { codec: "opus" },
    });
  });

  it("applies rungs, keyframes and stop to the pipeline", async () => {
    const { media, out, feed, enc } = setup();
    media.pipeline.ready(READY);
    at(1000);
    media.start(LADDER[2]!, (c) => out.push(c));
    await settle();
    feed(1000, 1200);
    media.apply(LADDER[3]!, 1);
    feed(1200, 1500);
    const barrier = out.find((c) => c.rung === 3)!;
    expect(barrier).toMatchObject({ key: true });
    media.keyframe(1200, 600);
    expect(enc().configs.at(-1)!.bitrate).toBe(1200 * 1000);
    media.stop();
    expect(enc().state).toBe("closed");
    expect(media.counters()).toMatchObject({ enc_queue: 0 });
  });

  it("reports the pipeline's errors to its hooks", async () => {
    const { media, hooks } = setup();
    media.pipeline.ready(READY);
    FakeVideoEncoder.supported = () => false;
    media.start(LADDER[2]!, () => {});
    await settle();
    expect(hooks.error).toHaveBeenCalledWith(
      "encoder_error",
      expect.any(String),
    );
  });
});
