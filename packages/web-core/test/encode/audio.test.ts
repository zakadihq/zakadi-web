import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TIMESLICE,
  audioConfig,
  createRecorder,
  recordAudio,
} from "../../src/encode/index.js";
import type { Chunk, EncodeEvent } from "../../src/encode/index.js";
import {
  FakeAudioData,
  FakeAudioEncoder,
  FakeMediaRecorder,
  FakeMediaStream,
  FakeTrack,
  channel,
  concat,
  installFakes,
  removeFakes,
  settle,
  source,
} from "./fakes.js";
import { READY, at, started } from "./harness.js";

// spec/06-web-sdk.md 6.2.4: the audio paths and the mediarecorder profile. Video frames
// arrive 5 ms after capture, so the media clock starts at 1005 ms on the engine's clock.
beforeEach(installFakes);
afterEach(removeFakes);

const MIC = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  sampleRate: 44100,
};
const audioChunks = (events: EncodeEvent[]) =>
  events.filter((e): e is Chunk => e.k === "chunk" && e.track === "audio");

describe("webcodecs-mstp", () => {
  it("encodes plane 0 of each AudioData as mono Opus at the rung's audio_kbps and the first AudioData's rate", async () => {
    const mic = source<AudioData>();
    const run = await started({
      audio: { kind: "readable", stream: mic.stream },
      settings: MIC,
    });
    run.feed(1000, 1010);
    mic.push(
      FakeAudioData.mic({ timestamp: 1_000_000, channels: 2, first: 7 }),
    );
    await settle();
    at(1015);
    mic.push(FakeAudioData.mic({ timestamp: 1_010_000, sampleRate: 16000 }));
    await settle();
    const aenc = FakeAudioEncoder.all[0]!;
    expect(aenc.configs).toEqual([audioConfig(48000, 24)]);
    expect(
      aenc.encoded.map((e) => [e.timestamp, e.channels, e.frames, e.first]),
    ).toEqual([
      [1_000_000, 1, 480, 7],
      [1_010_000, 1, 480, 0],
    ]);
    aenc.drain();
    expect(audioChunks(run.events).map((c) => [c.ptsMs, c.data])).toEqual([
      [0, Uint8Array.of(0x78, 1_000_000 & 255)],
      [10, Uint8Array.of(0x78, 1_010_000 & 255)],
    ]);
    expect(run.chunks("video")[0]?.config?.audio).toEqual({
      codec: "opus",
      sample_rate: 48000,
      channels: 1,
      bitrate_kbps: 24,
      frame_ms: 20,
      echo_cancellation: false,
      noise_suppression: false,
      auto_gain: false,
    });
    expect(FakeAudioData.all.every((a) => a.closes === 1)).toBe(true);
  });

  it("holds audio until the first video chunk, which carries config, and drops audio before start", async () => {
    const mic = source<AudioData>();
    mic.push(FakeAudioData.mic({ timestamp: 500_000 }));
    const run = await started({
      audio: { kind: "readable", stream: mic.stream },
      settings: { echoCancellation: true },
    });
    run.feed(1000, 1010, { drain: false });
    for (let ms = 1000; ms < 1100; ms += 10)
      mic.push(FakeAudioData.mic({ timestamp: ms * 1000 }));
    await settle();
    FakeAudioEncoder.all[0]!.drain();
    expect(run.chunks()).toEqual([]);
    run.enc().drain();
    const order = run.chunks().map((c) => c.track);
    expect(order).toEqual(["video", ...Array(10).fill("audio")]);
    expect(run.chunks()[0]?.config?.audio).toMatchObject({
      echo_cancellation: true,
      sample_rate: 48000,
    });
    expect(run.chunks()[0]?.config?.audio).not.toHaveProperty(
      "noise_suppression",
    );
    expect(FakeAudioEncoder.all[0]!.encoded).toHaveLength(10);
    expect(FakeAudioData.all.every((a) => a.closes === 1)).toBe(true);
  });
});

describe("webcodecs-worklet", () => {
  it("builds f32-planar AudioData from the worklet's blocks on the engine's clock", async () => {
    const [worklet, engine] = channel();
    const run = await started({
      audio: { kind: "pcm", port: engine, sampleRate: 44100 },
    });
    run.feed(1000, 1010);
    const block = (t: number) => ({ t, d: new Float32Array(882).fill(t) });
    worklet.postMessage(block(9.99));
    await settle();
    // No getOutputTimestamp() pair yet: the block's arrival (1005 ms) less its 20 ms.
    run.p.clock(1500, 10);
    worklet.postMessage(block(10.1));
    worklet.postMessage(block(10.12));
    await settle();
    const aenc = FakeAudioEncoder.all[0]!;
    expect(aenc.configs).toEqual([audioConfig(44100, 24)]);
    expect(
      aenc.encoded.map((e) => [e.timestamp, e.frames, e.channels]),
    ).toEqual([
      [985_000, 882, 1],
      [1_600_000, 882, 1],
      [1_620_000, 882, 1],
    ]);
    aenc.drain();
    expect(audioChunks(run.events).map((c) => c.ptsMs)).toEqual([0, 595, 615]);
    expect(run.chunks("video")[0]?.config).toMatchObject({
      clock_source: "aligned",
      audio: { sample_rate: 44100 },
    });
    expect(FakeAudioData.all.every((a) => a.closes === 1)).toBe(true);
  });
});

describe("recorder-opus and recorder-aac", () => {
  it("record the microphone clone at the start rung's bitrate and send its chunks unmodified", async () => {
    const [main, engine] = channel();
    const mic = new FakeTrack("audio");
    recordAudio(
      mic as unknown as MediaStreamTrack,
      "audio/webm;codecs=opus",
      main,
    );
    const run = await started({
      audio: { kind: "recorder", port: engine, container: "webm" },
      settings: MIC,
    });
    await settle();
    const rec = FakeMediaRecorder.all[0]!;
    expect(rec.stream.tracks).toEqual([mic]);
    expect(rec.options).toEqual({
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 24_000,
    });
    expect(rec.timeslice).toBe(TIMESLICE);
    run.feed(1000, 1010);
    const head = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);
    rec.push(head);
    rec.push(new Uint8Array(0));
    rec.push(Uint8Array.of(0x1f, 0x43));
    run.p.rung(3, 0);
    run.feed(1010, 1300);
    await settle();
    expect(audioChunks(run.events).map((c) => [c.ptsMs, c.data])).toEqual([
      [0, head],
      [395, Uint8Array.of(0x1f, 0x43)],
    ]);
    const configs = run
      .chunks("video")
      .flatMap((c) => (c.config ? [c.config.audio] : []));
    expect(configs).toEqual([
      expect.objectContaining({
        codec: "opus",
        container: "webm",
        sample_rate: 48000,
        bitrate_kbps: 24,
      }),
      expect.objectContaining({
        codec: "opus",
        container: "webm",
        bitrate_kbps: 24,
      }),
    ]);
    expect(configs[0]).not.toHaveProperty("frame_ms");
    run.p.stop();
    await settle();
    expect(rec.state).toBe("inactive");
  });

  it("report aac in mp4 at the microphone's rate, and a recorder error as encoder_error", async () => {
    const [main, engine] = channel();
    recordAudio(
      new FakeTrack("audio") as unknown as MediaStreamTrack,
      "audio/mp4",
      main,
    );
    const run = await started({
      audio: { kind: "recorder", port: engine, container: "mp4" },
      settings: MIC,
    });
    run.feed(1000, 1010);
    expect(run.chunks("video")[0]?.config?.audio).toMatchObject({
      codec: "aac",
      container: "mp4",
      sample_rate: 44100,
    });
    await settle();
    FakeMediaRecorder.all[0]!.onerror?.(new Event("error"));
    await settle();
    expect(run.events).toContainEqual(
      expect.objectContaining({ k: "error", code: "encoder_error" }),
    );
  });
});

describe("the mediarecorder profile", () => {
  const stream = () =>
    new FakeMediaStream([
      new FakeTrack("video", { frameRate: 24 }),
      new FakeTrack("audio"),
    ]);

  it("records the full stream at the start rung's bitrates and sends its chunks unmodified as video", async () => {
    const events: EncodeEvent[] = [];
    const s = stream();
    const p = createRecorder({
      stream: s as unknown as MediaStream,
      mimeType: "video/webm;codecs=vp8,opus",
      emit: (e) => events.push(e),
      settings: MIC,
    });
    p.ready(READY);
    at(1000);
    await p.start(2);
    const rec = FakeMediaRecorder.all[0]!;
    expect(rec.stream).toBe(s);
    expect(rec.options).toEqual({
      mimeType: "video/webm;codecs=vp8,opus",
      videoBitsPerSecond: 400_000,
      audioBitsPerSecond: 24_000,
    });
    expect(rec.timeslice).toBe(200);
    await settle();
    expect(events).toEqual([{ k: "t0", perfMs: 1000 }]);
    p.keyframe({ boost_kbps: 1200, boost_ms: 600 });
    p.rung(4, 2);
    for (let i = 0; i < 3; i++) rec.push(Uint8Array.of(i + 1, 0xa3));
    await settle();
    const chunks = events.filter((e): e is Chunk => e.k === "chunk");
    expect(
      chunks.map((c) => [c.track, c.ptsMs, c.rung, c.key, c.ps, c.rc, c.data]),
    ).toEqual([
      ["video", 0, 2, false, false, false, Uint8Array.of(1, 0xa3)],
      ["video", 200, 2, false, false, false, Uint8Array.of(2, 0xa3)],
      ["video", 400, 2, false, false, false, Uint8Array.of(3, 0xa3)],
    ]);
    expect(chunks[0]?.config).toEqual({
      t: "config",
      video: {
        codec: "vp8",
        w: 480,
        h: 640,
        fps: 15,
        bitrate_kbps: 400,
        annexb: false,
        container: "webm",
        mirrored: false,
        rotation: 0,
      },
      audio: {
        codec: "opus",
        sample_rate: 48000,
        channels: 1,
        bitrate_kbps: 24,
        muxed_in_video: true,
        echo_cancellation: false,
        noise_suppression: false,
        auto_gain: false,
      },
      rung: 2,
      clock_source: "aligned",
    });
    expect(chunks.slice(1).every((c) => !c.config)).toBe(true);
    expect(FakeMediaRecorder.all).toHaveLength(1);
    expect(p.stats()).toEqual({
      enc_queue: 0,
      pre_encode_drops: 0,
      captured_fps: 24,
    });
    p.stop();
    rec.push(Uint8Array.of(9));
    await settle();
    expect(events.filter((e) => e.k === "chunk")).toHaveLength(3);
  });

  it("reports the H.264 profile and level of an MP4 recording from its avcC record, with muxed AAC", async () => {
    const events: EncodeEvent[] = [];
    const p = createRecorder({
      stream: stream() as unknown as MediaStream,
      mimeType: "video/mp4",
      emit: (e) => events.push(e),
    });
    p.ready(READY);
    await p.start(3);
    await settle();
    const avcC = Uint8Array.of(
      0x61,
      0x76,
      0x63,
      0x43,
      1,
      0x4d,
      0x40,
      0x1e,
      0xff,
    );
    FakeMediaRecorder.all[0]!.push(
      concat([Uint8Array.of(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70), avcC]),
    );
    await settle();
    const [first] = events.filter((e): e is Chunk => e.k === "chunk");
    expect(first?.config?.video).toMatchObject({
      codec: "avc1.4D401E",
      container: "mp4",
      w: 336,
      h: 448,
    });
    expect(first?.config?.audio).toMatchObject({
      codec: "aac",
      muxed_in_video: true,
      sample_rate: 48000,
    });
  });
});
