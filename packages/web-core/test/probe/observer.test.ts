import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameObserver } from "../../src/probe/observer";
import {
  FakePlainVideo,
  FakeProcessor,
  FakeStream,
  FakeTrack,
  FakeVideo,
  fakeDocument,
  fakeFrame,
} from "../capture/fakes";

// Captured before the fake timers replace it: lets pending promises settle.
const realTimeout = setTimeout;
const settle = () => new Promise<void>((r) => realTimeout(r, 0));

const track = () => new FakeTrack({ settings: { width: 320, height: 240 } });
const observe = (t: FakeTrack) =>
  frameObserver(t as unknown as MediaStreamVideoTrack);

beforeEach(() => {
  vi.useFakeTimers();
  FakeProcessor.instances.length = 0;
  vi.stubGlobal("MediaStream", FakeStream);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("frameObserver() through MSTP", () => {
  beforeEach(() => {
    vi.stubGlobal("MediaStreamTrackProcessor", FakeProcessor);
  });

  async function push(
    p: FakeProcessor,
    afterMs: number,
    ts: number,
    w: number,
    h: number,
  ) {
    vi.advanceTimersByTime(afterMs);
    const frame = fakeFrame(ts, w, h);
    p.push(frame);
    await settle();
    return frame;
  }

  it("reads a clone and counts from the first frame of the requested size", async () => {
    const t = track();
    const obs = observe(t)!;
    expect(obs.method).toBe("mstp");
    const [p] = FakeProcessor.instances;
    expect(p!.track.source).toBe(t);

    const seen = obs.collect({ w: 480, h: 640 }, 400);
    const stale = await push(p!, 0, 0, 320, 240);
    await push(p!, 40, 40_000, 640, 480); // the new size, either orientation
    await push(p!, 33, 73_333, 640, 480);
    const last = await push(p!, 33, 106_667, 640, 480);
    await expect(seen).resolves.toEqual([{ w: 640, h: 480, fps: 30 }, 40]);
    expect([stale.closed, last.closed]).toEqual([true, true]);
  });

  it("counts from the first frame after the call for a frame rate step", async () => {
    const obs = observe(track())!;
    const [p] = FakeProcessor.instances;
    vi.advanceTimersByTime(100);
    const seen = obs.collect(null, 400);
    await push(p!, 12, 500_000, 480, 640);
    await push(p!, 100, 600_000, 480, 640);
    await push(p!, 100, 700_000, 480, 640);
    await expect(seen).resolves.toEqual([{ w: 480, h: 640, fps: 10 }, 112]);
  });

  it("ends at the timeout, fps null below two frames", async () => {
    const obs = observe(track())!;
    const [p] = FakeProcessor.instances;
    const one = obs.collect(null, 400);
    await push(p!, 10, 1_000, 480, 640);
    vi.advanceTimersByTime(400);
    await expect(one).resolves.toEqual([{ w: 480, h: 640, fps: null }, 10]);

    const none = obs.collect({ w: 480, h: 640 }, 400);
    await push(p!, 10, 2_000, 320, 240);
    vi.advanceTimersByTime(400);
    await expect(none).resolves.toEqual([
      { w: 320, h: 240, fps: null },
      undefined,
    ]);
  });

  it("ignores frames between collections", async () => {
    const obs = observe(track())!;
    const [p] = FakeProcessor.instances;
    await push(p!, 0, 0, 480, 640);
    const seen = obs.collect(null, 50);
    vi.advanceTimersByTime(50);
    await expect(seen).resolves.toEqual([
      { w: null, h: null, fps: null },
      undefined,
    ]);
  });

  it("cancels the reader and stops the clone on close", async () => {
    const obs = observe(track())!;
    const [p] = FakeProcessor.instances;
    obs.close();
    await settle();
    expect(p!.cancelled).toBe(true);
    expect(p!.track.readyState).toBe("ended");
  });
});

describe("frameObserver() through requestVideoFrameCallback", () => {
  beforeEach(() => {
    vi.stubGlobal("MediaStreamTrackProcessor", undefined);
  });

  it("plays a clone in a hidden video and times frames by capture time", async () => {
    const video = new FakeVideo();
    const doc = fakeDocument(video);
    vi.stubGlobal("document", doc);
    const t = track();
    const obs = observe(t)!;
    expect(obs.method).toBe("rvfc");
    expect((video.srcObject as FakeStream).tracks).toEqual([t.clones[0]]);
    expect(video).toMatchObject({
      muted: true,
      playsInline: true,
      played: true,
    });
    expect(video.style.cssText).toContain("opacity:0");
    expect(doc.appended).toEqual([video]);

    const seen = obs.collect({ w: 480, h: 640 }, 400);
    video.present({ width: 320, height: 240, captureTime: 1 });
    vi.advanceTimersByTime(20);
    video.present({ width: 480, height: 640, captureTime: 1000 });
    vi.advanceTimersByTime(40);
    video.present({ width: 480, height: 640, expectedDisplayTime: 1040 });
    video.present({ width: 480, height: 640, captureTime: 1080 });
    await expect(seen).resolves.toEqual([{ w: 480, h: 640, fps: 25 }, 20]);

    obs.close();
    expect(video.pending).toBe(0);
    expect(video.removed).toBe(true);
    expect(t.clones[0]!.readyState).toBe("ended");
  });

  it("is undefined where the video element has no requestVideoFrameCallback", () => {
    vi.stubGlobal("document", fakeDocument(new FakePlainVideo()));
    const t = track();
    expect(observe(t)).toBeUndefined();
    expect(t.clones.every((c) => c.readyState === "ended")).toBe(true);
  });
});
