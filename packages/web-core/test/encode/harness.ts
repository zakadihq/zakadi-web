import { vi } from "vitest";
import { createEncoder } from "../../src/encode/index.js";
import type {
  Chunk,
  EncodeEvent,
  EncoderOptions,
  Pipeline,
} from "../../src/encode/index.js";
import { FakeVideoEncoder, FakeVideoFrame, settle } from "./fakes.js";

/** The `ready` ladder of spec/01-protocol.md 1.5. */
export const LADDER = [
  { rung: 0, w: 480, h: 640, fps: 20, video_kbps: 900, audio_kbps: 24 },
  { rung: 1, w: 480, h: 640, fps: 20, video_kbps: 600, audio_kbps: 24 },
  { rung: 2, w: 480, h: 640, fps: 15, video_kbps: 400, audio_kbps: 24 },
  { rung: 3, w: 336, h: 448, fps: 12, video_kbps: 250, audio_kbps: 16 },
  { rung: 4, w: 288, h: 384, fps: 10, video_kbps: 150, audio_kbps: 12 },
];
export const READY = { ladder: LADDER, gop_ms: 2000 };

/** Moves the fake clock (performance.now() and timers) to `ms`. */
export function at(ms: number): void {
  vi.advanceTimersByTime(ms - performance.now());
}

/** A 480 x 640 camera frame captured at `ms` on the performance clock. */
export function camera(
  ms: number,
  o: {
    width?: number;
    height?: number;
    rotation?: number;
    flip?: boolean;
  } = {},
): VideoFrame {
  return FakeVideoFrame.camera({
    width: 480,
    height: 640,
    ...o,
    timestamp: Math.round(ms * 1000),
  });
}

export interface Run {
  p: Pipeline;
  events: EncodeEvent[];
  chunks(track?: "video" | "audio"): Chunk[];
  /** The video encoder running now. */
  enc(): FakeVideoEncoder;
  /**
   * Delivers the frames of a camera running at `fps` on whole milliseconds, from `from` to
   * before `to`, each 5 ms after its capture through Pipeline.frame, draining the encoder
   * after each frame unless told not to.
   */
  feed(
    from: number,
    to: number,
    o?: { fps?: number; drain?: boolean; frame?: (ms: number) => VideoFrame },
  ): void;
}

/** A pipeline on the `frames` source, `ready` at 0 ms and started at `rung` at 1000 ms. */
export async function started(
  o: Partial<Omit<EncoderOptions, "emit">> & { rung?: number } = {},
): Promise<Run> {
  const events: EncodeEvent[] = [];
  const p = createEncoder({
    video: { kind: "frames" },
    audio: { kind: "none" },
    ...o,
    emit: (e) => events.push(e),
  });
  const run: Run = {
    p,
    events,
    chunks: (track) =>
      events.filter(
        (e): e is Chunk => e.k === "chunk" && (!track || e.track === track),
      ),
    enc: () => FakeVideoEncoder.all[FakeVideoEncoder.all.length - 1]!,
    feed(from, to, f = {}) {
      for (let n = 0; ; n++) {
        const ms = Math.round((n * 1000) / (f.fps ?? 30));
        if (ms >= to) break;
        if (ms < from) continue;
        at(ms + 5);
        p.frame((f.frame ?? camera)(ms));
        if (f.drain !== false) run.enc().drain();
      }
    },
  };
  p.ready(READY);
  at(1000);
  await p.start(o.rung ?? 2);
  await settle();
  return run;
}
