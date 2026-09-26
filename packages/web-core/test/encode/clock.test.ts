import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureTimestamp, createEncoder } from "../../src/encode/index.js";
import type {
  AudioSource,
  Chunk,
  EncodeEvent,
} from "../../src/encode/index.js";
import {
  FakeAudioData,
  FakeAudioEncoder,
  FakeVideoEncoder,
  FakeVideoFrame,
  channel,
  installFakes,
  removeFakes,
  settle,
  source,
} from "./fakes.js";
import { READY, at, started } from "./harness.js";

// spec/06-web-sdk.md 6.2.5 and spec/01-protocol.md 1.3.3: the session media clock.
beforeEach(installFakes);
afterEach(removeFakes);

const chunks = (events: EncodeEvent[], track: "video" | "audio") =>
  events.filter((e): e is Chunk => e.k === "chunk" && e.track === track);

/**
 * A Chromium session: an MSTP video stream in a timebase `videoUs` ahead of the page clock,
 * an MSTP audio stream `audioUs` ahead, both read from 0 ms, `ready` at 500 ms and
 * `probe_result` at 1000 ms. Buffers arrive 5 ms after capture.
 */
async function chromium(videoUs: number, audioUs: number) {
  const events: EncodeEvent[] = [];
  const cam = source<VideoFrame>();
  const mic = source<AudioData>();
  const p = createEncoder({
    video: { kind: "readable", stream: cam.stream },
    audio: { kind: "readable", stream: mic.stream },
    emit: (e) => events.push(e),
  });
  const run = async (from: number, to: number) => {
    for (let ms = from; ms < to; ms += 10) {
      at(ms + 5);
      mic.push(FakeAudioData.mic({ timestamp: ms * 1000 + audioUs }));
      if (ms % 50 === 0)
        cam.push(
          FakeVideoFrame.camera({
            width: 480,
            height: 640,
            timestamp: ms * 1000 + videoUs,
          }),
        );
      await settle();
      FakeVideoEncoder.all.at(-1)?.drain();
      FakeAudioEncoder.all.at(-1)?.drain();
    }
  };
  await run(0, 500);
  p.ready(READY);
  await run(500, 1000);
  await p.start(2);
  await run(1000, 1500);
  return { p, events };
}

describe("t0", () => {
  it("is the first frame the camera pipeline delivers after ready", async () => {
    const events: EncodeEvent[] = [];
    const p = createEncoder({
      video: { kind: "frames" },
      audio: { kind: "none" },
      emit: (e) => events.push(e),
    });
    at(5);
    p.frame(FakeVideoFrame.camera({ width: 480, height: 640, timestamp: 0 }));
    p.ready(READY);
    expect(events).toEqual([]);
    at(138);
    p.frame(
      FakeVideoFrame.camera({ width: 480, height: 640, timestamp: 133_000 }),
    );
    at(171);
    p.frame(
      FakeVideoFrame.camera({ width: 480, height: 640, timestamp: 166_000 }),
    );
    expect(events).toEqual([{ k: "t0", perfMs: 138 }]);
    await p.start(2);
    at(205);
    p.frame(
      FakeVideoFrame.camera({ width: 480, height: 640, timestamp: 200_000 }),
    );
    FakeVideoEncoder.all[0]!.drain();
    expect(chunks(events, "video").map((c) => c.ptsMs)).toEqual([67]);
  });
});

describe("clock_source", () => {
  it("is shared when the tracks' K agree within 20 ms, and audio then uses t0 directly", async () => {
    const { events } = await chromium(7_000_000, 7_019_000);
    const [first] = chunks(events, "video");
    expect(first?.config?.clock_source).toBe("shared");
    expect(first?.ptsMs).toBe(500);
    // Audio captured at 1000 ms is stamped 19 ms later than video by its own clock.
    expect(chunks(events, "audio")[0]?.ptsMs).toBe(519);
  });

  it("is aligned otherwise, each track mapped to the page clock at capture", async () => {
    const { events } = await chromium(7_000_000, 7_020_000);
    const [first] = chunks(events, "video");
    expect(first?.config?.clock_source).toBe("aligned");
    expect(first?.ptsMs).toBe(500);
    expect(chunks(events, "audio")[0]?.ptsMs).toBe(500);
  });

  it.each<[string, AudioSource]>([
    ["worklet", { kind: "pcm", port: channel()[1], sampleRate: 48000 }],
    ["recorder", { kind: "recorder", port: channel()[1], container: "webm" }],
  ])("is aligned on the %s path", async (_path, audio) => {
    const run = await started({ audio });
    run.feed(1000, 1010);
    expect(run.chunks("video")[0]?.config?.clock_source).toBe("aligned");
  });
});

describe("pts", () => {
  it("never decreases per track", async () => {
    const [worklet, engine] = channel();
    const run = await started({
      audio: { kind: "pcm", port: engine, sampleRate: 48000 },
    });
    // Video delivered with a varying delay; an audio clock pair that moves back 120 ms.
    [0, 40, 3, 60, 1, 50, 2].forEach((delay, i) => {
      const ms = 1000 + i * 67;
      at(ms + delay);
      run.p.frame(
        FakeVideoFrame.camera({
          width: 480,
          height: 640,
          timestamp: ms * 1000,
        }),
      );
      run.enc().drain();
    });
    run.p.clock(1500, 10);
    worklet.postMessage({ t: 10.1, d: new Float32Array(960) });
    await settle();
    run.p.clock(1380, 10.1);
    worklet.postMessage({ t: 10.12, d: new Float32Array(960) });
    worklet.postMessage({ t: 10.14, d: new Float32Array(960) });
    await settle();
    FakeAudioEncoder.all[0]!.drain();
    const video = run.chunks("video").map((c) => c.ptsMs);
    const audio = run.chunks("audio").map((c) => c.ptsMs);
    expect(video).toHaveLength(7);
    expect(audio).toEqual([600, 600, 600]);
    for (const pts of [video, audio])
      expect(pts).toEqual([...pts].sort((a, b) => a - b));
  });
});

describe("rVFC frames", () => {
  it("are stamped with captureTime, else expectedDisplayTime, in microseconds", () => {
    const m = { expectedDisplayTime: 1016.7, width: 480, height: 640 };
    const meta = m as unknown as VideoFrameCallbackMetadata;
    expect(captureTimestamp(meta)).toBe(1_016_700);
    expect(captureTimestamp({ ...meta, captureTime: 990.25 })).toBe(990_250);
  });
});
