import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEncoder } from "../../src/encode/index.js";
import type { EncodeEvent } from "../../src/encode/index.js";
import {
  FakeAudioData,
  FakeAudioEncoder,
  FakeMediaStreamTrackProcessor,
  FakeOffscreenCanvas,
  FakeTrack,
  FakeVideoEncoder,
  FakeVideoFrame,
  IDR,
  PPS,
  SLICE,
  annexB,
  avccRecord,
  installFakes,
  lengthPrefixed,
  removeFakes,
  settle,
  source,
  sps,
} from "./fakes.js";
import type { Encoded, Output } from "./fakes.js";
import { READY, at, camera, started } from "./harness.js";

// spec/06-web-sdk.md 6.2.4 and 6.2.7: the video encoder of the webcodecs profile. The camera
// runs at 30 fps and rung 2 at 15 fps, so every second frame is selected.
beforeEach(installFakes);
afterEach(removeFakes);

const keyTimes = (es: Encoded[]) =>
  es.filter((e) => e.keyFrame).map((e) => e.timestamp);
const frame = (i: number) => Math.round(1000 + (i * 1000) / 30);

describe("the codec in config", () => {
  it("comes from the SPS of the first key chunk after each configure()", async () => {
    let level = 0x1e;
    FakeVideoEncoder.write = (e) =>
      e.keyFrame
        ? { data: annexB(sps(level, 0x42, 0xc0), PPS, IDR), type: "key" }
        : { data: annexB(SLICE), type: "delta" };
    const run = await started();
    run.feed(1000, 1500);
    level = 0x1f;
    run.p.rung(3, 0);
    run.feed(1500, 2000);
    const configs = run
      .chunks("video")
      .flatMap((c) => (c.config ? [c.config] : []));
    expect(configs.map((c) => [c.rung, c.video.codec])).toEqual([
      [2, "avc1.42C01E"],
      [3, "avc1.42C01F"],
    ]);
  });

  it("moves to the next candidate when the level exceeds 31 before any media, discarding the chunk", async () => {
    FakeVideoEncoder.write = (e) =>
      e.keyFrame
        ? {
            data: annexB(
              sps(e.config.bitrateMode === "constant" ? 0x28 : 0x1f),
              PPS,
              IDR,
            ),
            type: "key",
          }
        : { data: annexB(SLICE), type: "delta" };
    const run = await started();
    run.feed(1000, 1500);
    const [first, second] = FakeVideoEncoder.all;
    expect(first?.state).toBe("closed");
    expect(first?.encoded).toHaveLength(1);
    expect(second?.configs[0]).toMatchObject({
      hardwareAcceleration: "prefer-hardware",
      bitrateMode: "variable",
    });
    const video = run.chunks("video");
    expect(video[0]).toMatchObject({
      ptsMs: 67,
      key: true,
      config: { video: { codec: "avc1.42E01F" } },
    });
    expect(video.every((c) => !c.data.includes(0x28))).toBe(true);
  });

  it("keeps a level above 31 once media has been sent, and reports it", async () => {
    let level = 0x1f;
    FakeVideoEncoder.write = (e) =>
      e.keyFrame
        ? { data: annexB(sps(level), PPS, IDR), type: "key" }
        : { data: annexB(SLICE), type: "delta" };
    const run = await started();
    run.feed(1000, 1200);
    level = 0x28;
    run.p.rung(3, 0);
    run.feed(1200, 1400);
    expect(FakeVideoEncoder.all).toHaveLength(1);
    expect(
      run
        .chunks("video")
        .flatMap((c) => (c.config ? [c.config.video.codec] : [])),
    ).toEqual(["avc1.42E01F", "avc1.42E028"]);
  });
});

describe("access units", () => {
  it("give an IDR lacking SPS and PPS the cached ones and param_sets", async () => {
    let n = 0;
    FakeVideoEncoder.write = (e) =>
      e.keyFrame
        ? { data: n++ ? annexB(IDR) : annexB(sps(), PPS, IDR), type: "key" }
        : { data: annexB(SLICE), type: "delta" };
    const run = await started();
    run.feed(1000, 3100);
    const keys = run.chunks("video").filter((c) => c.key);
    expect(keys.map((k) => k.ptsMs)).toEqual([0, 2000]);
    for (const k of keys)
      expect(k).toMatchObject({ data: annexB(sps(), PPS, IDR), ps: true });
    expect(
      run
        .chunks("video")
        .filter((c) => !c.key)
        .every((c) => !c.ps),
    ).toBe(true);
  });

  it("rewrite avcC output to start codes, with the description's SPS and PPS on key chunks", async () => {
    let first = true;
    FakeVideoEncoder.write = (e): Output => {
      const meta = first
        ? {
            decoderConfig: {
              codec: "avc1.42E01F",
              description: avccRecord(sps(), PPS),
            },
          }
        : undefined;
      first = false;
      const type = e.keyFrame ? "key" : "delta";
      return {
        data: lengthPrefixed(e.keyFrame ? IDR : SLICE),
        type,
        ...(meta ? { meta } : {}),
      };
    };
    const run = await started();
    run.feed(1000, 1100);
    const [key, delta] = run.chunks("video");
    expect(key).toMatchObject({
      data: annexB(sps(), PPS, IDR),
      key: true,
      ps: true,
    });
    expect(key?.config?.video).toMatchObject({
      codec: "avc1.42E01F",
      annexb: true,
    });
    expect(delta).toMatchObject({ data: annexB(SLICE), key: false, ps: false });
  });

  it("take VP8 flags from the chunk: keyframe from its type, param_sets 0", async () => {
    FakeVideoEncoder.supported = (c) => c.codec === "vp8";
    const run = await started();
    run.feed(1000, 1300);
    const video = run.chunks("video");
    expect(video.map((c) => [c.key, c.ps])).toEqual([
      [true, false],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
    ]);
    expect(video[0]?.data).toEqual(Uint8Array.of(0x10, 0x02, 0x9d));
  });
});

describe("keyframes", () => {
  it("follow gop_ms when nothing else asks for one", async () => {
    const run = await started();
    run.feed(1000, 7000);
    expect(keyTimes(run.enc().encoded)).toEqual([
      1_000_000, 3_000_000, 5_000_000,
    ]);
    expect(
      run.chunks("video").flatMap((c) => (c.key ? [c.ptsMs] : [])),
    ).toEqual([0, 2000, 4000]);
  });

  it("land on the next selected frame past decimation and the queue rule, at the boost bitrate for boost_ms", async () => {
    const run = await started();
    const enc = run.enc();
    run.feed(1000, 2000);
    run.p.rung(2, 2);
    // Selected at 2000, 2067, 2133, 2200, 2267 and 2333: decimation drops three, the
    // other three wait in the encoder.
    run.feed(2000, 2400, { drain: false });
    expect(run.p.stats()).toMatchObject({ enc_queue: 3, pre_encode_drops: 3 });
    at(2380);
    run.p.keyframe({ boost_kbps: 1200, boost_ms: 600 });
    expect(enc.configs.at(-1)?.bitrate).toBe(1_200_000);
    // The frame at 2400 is the next selected one; decimation and the queue would drop it.
    run.feed(2400, 2410, { drain: false });
    expect(enc.encoded.at(-1)).toMatchObject({
      timestamp: 2_400_000,
      keyFrame: true,
      config: { bitrate: 1_200_000 },
    });
    expect(run.p.stats()).toMatchObject({ enc_queue: 4, pre_encode_drops: 3 });
    at(2450);
    enc.drain();
    expect(run.chunks("video").at(-1)).toMatchObject({
      ptsMs: 1400,
      key: true,
      config: { video: { bitrate_kbps: 1200 } },
    });
    expect(run.events).toContainEqual({ k: "idr", ms: 70 });
    at(2979);
    expect(enc.configs.at(-1)?.bitrate).toBe(1_200_000);
    at(2980);
    expect(enc.configs.at(-1)?.bitrate).toBe(400_000);
    run.feed(frame(60), frame(62));
    expect(run.chunks("video").at(-1)).toMatchObject({
      ptsMs: 2000,
      key: false,
      config: { video: { bitrate_kbps: 400 } },
    });
  });

  it("are requested without a boost when the message carries none", async () => {
    const run = await started();
    run.feed(1000, 1500);
    run.p.keyframe({});
    run.feed(1500, 1600);
    expect(run.enc().configs).toHaveLength(1);
    expect(keyTimes(run.enc().encoded)).toEqual([1_000_000, 1_533_000]);
  });
});

describe("a rung change", () => {
  it("reconfigures, sets the barrier at the next submitted frame and keys it on a size change", async () => {
    const run = await started();
    const enc = run.enc();
    run.feed(1000, 1100, { drain: false });
    run.p.rung(3, 0);
    expect(enc.configs.at(-1)).toMatchObject({
      width: 336,
      height: 448,
      bitrate: 250_000,
      framerate: 12,
    });
    run.feed(frame(3), frame(5), { drain: false });
    expect(
      enc.encoded.map((e) => [e.timestamp, e.keyFrame, e.config.width]),
    ).toEqual([
      [1_000_000, true, 480],
      [1_067_000, false, 480],
      [1_133_000, true, 336],
    ]);
    run.feed(frame(5), frame(15));
    const video = run.chunks("video");
    expect(video.map((c) => [c.ptsMs, c.rung, c.rc, !!c.config])).toEqual([
      [0, 2, false, true],
      [67, 2, false, false],
      [133, 3, true, true],
      [233, 3, false, false],
      [300, 3, false, false],
      [400, 3, false, false],
      [467, 3, false, false],
    ]);
    expect(video[2]?.config).toMatchObject({
      rung: 3,
      video: { w: 336, h: 448, fps: 12, bitrate_kbps: 250 },
    });
  });

  it("does not key the barrier frame when the size stays", async () => {
    const run = await started();
    run.feed(1000, 1500);
    run.p.rung(1, 0);
    run.feed(1500, 1600);
    expect(run.chunks("video").find((c) => c.rc)).toMatchObject({
      ptsMs: 533,
      rung: 1,
      key: false,
      config: { rung: 1, video: { fps: 20, bitrate_kbps: 600 } },
    });
    expect(run.enc().configs.at(-1)).toMatchObject({
      width: 480,
      height: 640,
      framerate: 20,
      bitrate: 600_000,
    });
  });

  it("switches frame selection and decimation at once", async () => {
    const run = await started();
    run.feed(1000, 2000);
    expect(run.enc().encoded).toHaveLength(15);
    run.p.rung(2, 1);
    run.feed(2000, 3000);
    expect(run.enc().encoded).toHaveLength(15 + 12);
    expect(run.p.stats().pre_encode_drops).toBe(3);
    run.p.rung(4, 2);
    run.feed(3000, 4000);
    expect(run.enc().encoded).toHaveLength(15 + 12 + 5);
    expect(run.p.stats().pre_encode_drops).toBe(3 + 5);
  });

  it("moves Opus to the rung's audio_kbps at the barrier", async () => {
    const mic = source<AudioData>();
    const run = await started({
      audio: { kind: "readable", stream: mic.stream },
    });
    run.feed(1000, 1400);
    for (let ms = 1000; ms < 1400; ms += 10)
      mic.push(FakeAudioData.mic({ timestamp: ms * 1000 }));
    await settle();
    const aenc = FakeAudioEncoder.all[0]!;
    expect(aenc.configs.map((c) => c.bitrate)).toEqual([24_000]);
    run.p.rung(3, 0);
    run.feed(1400, 1500, { drain: false });
    expect(aenc.configs.map((c) => c.bitrate)).toEqual([24_000]);
    run.enc().drain();
    expect(aenc.configs.map((c) => c.bitrate)).toEqual([24_000, 16_000]);
    expect(
      run.chunks("video").find((c) => c.rc)?.config?.audio.bitrate_kbps,
    ).toBe(16);
  });
});

describe("drops and frames", () => {
  it("count decimation and queue drops only, and close every frame exactly once with at most three open", async () => {
    const run = await started();
    run.feed(1000, 2000);
    expect(run.p.stats()).toEqual({
      enc_queue: 0,
      pre_encode_drops: 0,
      captured_fps: 30,
    });
    run.p.rung(2, 1);
    // Chrome 138 camera frames: landscape with rotation metadata, redrawn and cropped.
    run.feed(2000, 2600, {
      frame: (ms) => camera(ms, { width: 1280, height: 720, rotation: 90 }),
    });
    expect(run.p.stats().pre_encode_drops).toBe(2);
    run.feed(2600, 3000, { drain: false });
    expect(run.p.stats()).toMatchObject({ enc_queue: 3, pre_encode_drops: 5 });
    expect(FakeVideoFrame.all).toHaveLength(30 + 18 + 7 * 2 + 12);
    expect(FakeVideoFrame.all.every((f) => f.closes === 1)).toBe(true);
    expect(FakeVideoFrame.live).toBe(0);
    expect(FakeVideoFrame.peak).toBe(3);
  });

  it("close frames that arrive before start, after stop, and on an encode error", async () => {
    const events: EncodeEvent[] = [];
    const p = createEncoder({
      video: { kind: "frames" },
      audio: { kind: "none" },
      emit: (e) => events.push(e),
    });
    p.frame(camera(0));
    p.ready(READY);
    at(1000);
    await p.start(2);
    const enc = FakeVideoEncoder.all[0]!;
    enc.encode = () => {
      throw new DOMException("bad frame", "DataError");
    };
    p.frame(camera(1000, { width: 640, height: 480 }));
    expect(events).toContainEqual(
      expect.objectContaining({ k: "error", code: "encoder_error" }),
    );
    p.stop();
    expect(enc.state).toBe("closed");
    p.frame(camera(1100));
    expect(FakeVideoFrame.all).toHaveLength(4);
    expect(FakeVideoFrame.all.every((f) => f.closes === 1)).toBe(true);
  });

  it("are read from an MSTP stream", async () => {
    const cam = source<VideoFrame>();
    const run = await started({
      video: { kind: "readable", stream: cam.stream },
    });
    cam.push(camera(1000));
    cam.push(camera(frame(2)));
    await settle();
    expect(keyTimes(run.enc().encoded)).toEqual([1_000_000]);
    expect(run.enc().encoded).toHaveLength(2);
    run.p.stop();
    await settle();
    expect(FakeVideoFrame.all.every((f) => f.closes === 1)).toBe(true);
  });

  it("are read from a track clone through MSTP in the worker, which stop() ends", async () => {
    const track = new FakeTrack("video");
    const run = await started({
      video: { kind: "track", track: track as unknown as MediaStreamTrack },
    });
    const mstp = FakeMediaStreamTrackProcessor.all[0]!;
    expect(mstp.track).toBe(track);
    mstp.push(camera(1000));
    await settle();
    expect(run.enc().encoded).toHaveLength(1);
    run.p.stop();
    expect(track.stopped).toBe(true);
  });
});

describe("orientation, crop and scale", () => {
  it("redraws rotated or flipped frames upright into one reused OffscreenCanvas", async () => {
    const run = await started();
    const shapes = [
      { width: 640, height: 480, rotation: 90 },
      { width: 480, height: 640, flip: true },
      { width: 640, height: 480, rotation: 270, flip: true },
      { width: 480, height: 640, rotation: 180 },
    ];
    shapes.forEach((s, i) =>
      run.feed(1000 + i * 100, 1001 + i * 100, {
        frame: (ms) => camera(ms, s),
      }),
    );
    expect(FakeOffscreenCanvas.all).toHaveLength(1);
    expect(
      FakeOffscreenCanvas.all[0]!.draws.map((d) => [
        d.frame.rotation,
        d.frame.flip,
        d.w,
        d.h,
      ]),
    ).toEqual([
      [90, false, 480, 640],
      [0, true, 480, 640],
      [270, true, 480, 640],
      [180, false, 480, 640],
    ]);
    expect(
      run.enc().encoded.map((e) => [e.timestamp, e.width, e.height]),
    ).toEqual([
      [1_000_000, 480, 640],
      [1_100_000, 480, 640],
      [1_200_000, 480, 640],
      [1_300_000, 480, 640],
    ]);
    expect(run.chunks("video")[0]?.config?.video).toMatchObject({
      rotation: 0,
      mirrored: false,
    });
  });

  it("crops the centre 3:4 region by an even visibleRect", async () => {
    const run = await started();
    const shapes = [
      { width: 640, height: 480 },
      { width: 1280, height: 720, rotation: 90 },
      { width: 722, height: 962 },
      { width: 480, height: 640 },
    ];
    shapes.forEach((s, i) =>
      run.feed(1000 + i * 100, 1001 + i * 100, {
        frame: (ms) => camera(ms, s),
      }),
    );
    expect(run.enc().encoded.map((e) => e.rect)).toEqual([
      { x: 140, y: 0, width: 360, height: 480 },
      { x: 0, y: 160, width: 720, height: 960 },
      { x: 0, y: 0, width: 720, height: 960 },
      { x: 0, y: 0, width: 480, height: 640 },
    ]);
    expect(FakeOffscreenCanvas.all[0]).toMatchObject({
      width: 720,
      height: 1280,
    });
  });
});
