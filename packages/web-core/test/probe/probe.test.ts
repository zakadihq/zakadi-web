import { validateCameraMetaMsg } from "@zakadi/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cameraMeta } from "../../src/capture/meta";
import type { FrameObserver } from "../../src/probe/observer";
import { cameraProbe, STEPS } from "../../src/probe/probe";
import {
  FakePlainVideo,
  FakeProcessor,
  FakeStream,
  FakeTrack,
  fakeDocument,
  fakeFrame,
  installMedia,
} from "../capture/fakes";

// The 1.4 order as applyConstraints receives it.
const ORDER = [
  { height: 3001 },
  { height: 11 },
  { height: 640 },
  { height: 240 },
  { height: 2001 },
  { height: 22 },
  { height: 1001 },
  { frameRate: 200 },
  { frameRate: 1 },
  { frameRate: 60 },
  { frameRate: 120 },
  { frameRate: 5 },
  { frameRate: 30 },
];

const SESSION = {
  facingMode: "user",
  width: { ideal: 480 },
  height: { ideal: 640 },
  frameRate: { ideal: 30 },
};

// A camera with portrait modes from 90 x 120 to 720 x 1280 and 5 to 30 fps.
const clamp = (v: unknown, lo: number, hi: number, current: number) =>
  v === undefined
    ? current
    : Math.min(
        hi,
        Math.max(
          lo,
          typeof v === "number" ? v : (v as { ideal: number }).ideal,
        ),
      );
const camera = (applyMs: number) =>
  new FakeTrack({
    applyMs,
    settings: { width: 480, height: 640, frameRate: 30 },
    resolve: (c, s) => {
      const height = clamp(c.height, 120, 1280, s.height!);
      const frameRate = clamp(c.frameRate, 5, 30, s.frameRate!);
      return { ...s, height, width: Math.round(height * 0.5625), frameRate };
    },
  });

// An observer that sees the track's settings `delay` ms after each collect, or never.
function scripted(t: FakeTrack, delay: number | null): FrameObserver {
  return {
    method: "mstp",
    close: vi.fn(),
    collect: (_, timeoutMs) =>
      new Promise((resolve) => {
        if (delay === null || delay > timeoutMs) {
          setTimeout(
            () => resolve([{ w: 320, h: 240, fps: 30 }, undefined]),
            timeoutMs,
          );
          return;
        }
        setTimeout(() => {
          const s = t.getSettings();
          resolve([
            { w: s.width!, h: s.height!, fps: s.frameRate! },
            performance.now(),
          ]);
        }, delay);
      }),
  };
}

async function probe(t: FakeTrack, observer?: FrameObserver) {
  const started = performance.now();
  const done = cameraProbe(
    t as unknown as MediaStreamVideoTrack,
    SESSION,
    observer,
  );
  let finished = NaN;
  void done.then(() => (finished = performance.now()));
  await vi.runAllTimersAsync();
  return { entries: await done, ms: finished - started };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeProcessor.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("cameraProbe()", () => {
  it("applies the 13 steps in 1.4 order and restores the session constraints", async () => {
    const t = camera(40);
    const observer = scripted(t, 60);
    const { entries } = await probe(t, observer);
    expect(STEPS).toHaveLength(13);
    expect(t.applied).toEqual([...ORDER, SESSION]);
    expect(entries.map((e) => e.request)).toEqual(STEPS);
    expect(entries[0]).toEqual({
      request: { height: 3001 },
      reported: { w: 720, h: 1280, fps: 30 },
      observed: { w: 720, h: 1280, fps: 30 },
      reconfig_ms: 100,
      method: "mstp",
    });
    expect(entries[8]).toEqual({
      request: { fps: 1 },
      reported: { w: 563, h: 1001, fps: 5 },
      observed: { w: 563, h: 1001, fps: 5 },
      reconfig_ms: 100,
      method: "mstp",
    });
    expect(entries.every((e) => !e.skipped)).toBe(true);
    expect(observer.close).toHaveBeenCalledOnce();
  });

  it("marks the steps past the 3 s budget skipped", async () => {
    const t = camera(700);
    const { entries, ms } = await probe(t, scripted(t, null));
    expect(entries.map((e) => e.request)).toEqual(STEPS);
    expect(entries.slice(0, 3).every((e) => !e.skipped)).toBe(true);
    expect(entries.slice(3)).toEqual(
      STEPS.slice(3).map((request) => ({ request, skipped: true })),
    );
    // Three steps in 3000 ms, then the restore.
    expect(t.applied).toEqual([...ORDER.slice(0, 3), SESSION]);
    expect(ms).toBe(3700);
  });

  it("gives up on a call still pending at the deadline and bounds the restore", async () => {
    const t = camera(2500);
    const { entries, ms } = await probe(t, scripted(t, 30));
    expect(entries[0]).toMatchObject({
      request: { height: 3001 },
      reconfig_ms: 2530,
    });
    expect(entries.slice(1).every((e) => e.skipped)).toBe(true);
    expect(t.applied).toEqual([ORDER[0], ORDER[1], SESSION]);
    expect(ms).toBe(4000);
  });

  it("leaves reconfig_ms out when no frame of the new size arrives", async () => {
    const t = camera(10);
    const { entries } = await probe(t, scripted(t, null));
    expect(entries[0]).toEqual({
      request: { height: 3001 },
      reported: { w: 720, h: 1280, fps: 30 },
      observed: { w: 320, h: 240, fps: 30 },
      method: "mstp",
    });
  });

  it("reports the settings as observed where neither MSTP nor rVFC exists", async () => {
    vi.stubGlobal("MediaStreamTrackProcessor", undefined);
    vi.stubGlobal("document", fakeDocument(new FakePlainVideo()));
    const t = camera(25);
    const { entries } = await probe(t);
    expect(entries[2]).toEqual({
      request: { height: 640 },
      reported: { w: 360, h: 640, fps: 30 },
      observed: { w: 360, h: 640, fps: 30 },
      reconfig_ms: 25,
      method: "getSettings",
    });
  });
});

describe("the probe with its MSTP observer", () => {
  it("measures a camera that serves frames at its settings, and feeds a valid camera_meta", async () => {
    vi.stubGlobal("MediaStreamTrackProcessor", FakeProcessor);
    vi.stubGlobal("MediaStream", FakeStream);
    const t = camera(50);
    // The camera: a frame of the current size every 1000 / frameRate ms.
    let ts = 0;
    const serve = () => {
      const s = t.getSettings();
      for (const p of FakeProcessor.instances) {
        if (!p.cancelled) p.push(fakeFrame(ts, s.width!, s.height!));
      }
      const interval = 1000 / s.frameRate!;
      ts += interval * 1000;
      setTimeout(serve, interval);
    };
    serve();
    const done = cameraProbe(t as unknown as MediaStreamVideoTrack, SESSION);
    await vi.advanceTimersByTimeAsync(5000);
    const entries = await done;

    expect(entries.every((e) => e.method === "mstp" && !e.skipped)).toBe(true);
    for (const e of entries.slice(0, 7)) {
      expect(e.observed).toMatchObject({
        w: e.reported!.w,
        h: e.reported!.h,
        fps: 30,
      });
      expect(e.reconfig_ms).toBeGreaterThanOrEqual(50);
    }
    expect(entries[8]!.observed).toMatchObject({ fps: 5 });
    expect(FakeProcessor.instances[0]!.cancelled).toBe(true);

    installMedia({});
    const meta = await cameraMeta(
      t as unknown as MediaStreamTrack,
      entries,
      {
        impl: "unknown",
        is_config_supported: { "avc1.42E01F": false, vp8: true },
      },
      new Uint8Array(16),
    );
    expect(validateCameraMetaMsg(JSON.parse(JSON.stringify(meta)))).toBe(true);
  });
});
