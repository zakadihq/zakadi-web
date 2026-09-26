// Fakes for the engine and session tests (spec/06-web-sdk.md 6.11): an encode Pipeline
// on the virtual clock, which the engine wraps with its adapter as it wraps the real
// encoders, and a Worker whose script is scripted by the test.
import type { ConfigMsg, KeyframeMsg, ReadyMsg } from "@zakadi/protocol";
import type {
  EncodeEvent,
  EncodeStats,
  Pipeline,
} from "../../src/encode/types";
import type { FromEngine, InitMsg, ToEngine } from "../../src/engine/messages";

type Rung = ReadyMsg["ladder"][number];

/**
 * An encoder pipeline on the virtual clock: `t0` at the first frame after `ready`, then
 * from start() video chunks at the rung's frame rate less the decimation, sized at the
 * rung's video rate (keyframes 5 times larger, every `gop_ms`), each carrying `config`
 * when the configuration changed, and 20 ms audio packets after the first video chunk.
 */
export class FakePipeline implements Pipeline {
  static all: FakePipeline[] = [];
  calls: unknown[][] = [];
  stopped = false;
  private ladder: Rung[] = [];
  private gop = 2000;
  private t0: number | undefined;
  private rungIn = 0;
  private out = 0;
  private dec: 0 | 1 | 2 = 0;
  private n = 0;
  private key = true;
  private lastKey = -Infinity;
  private pending = true; // config due on the next video chunk
  private barrier = false;
  private sentVideo = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    readonly init: InitMsg,
    readonly emit: (e: EncodeEvent) => void,
  ) {
    FakePipeline.all.push(this);
  }

  /** The newest pipeline. */
  static get last(): FakePipeline {
    return FakePipeline.all[FakePipeline.all.length - 1]!;
  }

  ready(msg: Pick<ReadyMsg, "ladder" | "gop_ms">): void {
    this.calls.push(["ready"]);
    this.ladder = msg.ladder;
    this.gop = msg.gop_ms;
    this.after(33, () => {
      this.t0 = performance.now();
      this.emit({ k: "t0", perfMs: this.t0 });
    });
  }

  async start(rung: number): Promise<void> {
    this.calls.push(["start", rung]);
    this.rungIn = this.out = rung;
    this.after(1000 / this.ladder[rung]!.fps, () => this.video());
    this.after(20, () => this.sound());
  }

  rung(to: number, decimation: 0 | 1 | 2): void {
    this.calls.push(["rung", to, decimation]);
    this.dec = decimation;
    if (to === this.rungIn) return;
    const a = this.ladder[this.rungIn]!;
    const b = this.ladder[to]!;
    if (a.w !== b.w || a.h !== b.h) this.key = true;
    this.rungIn = to;
    this.barrier = true;
  }

  keyframe(msg: Pick<KeyframeMsg, "boost_kbps" | "boost_ms">): void {
    this.calls.push(["keyframe", msg.boost_kbps, msg.boost_ms]);
    this.key = true;
  }

  frame(frame: VideoFrame): void {
    this.calls.push(["frame"]);
    frame.close();
  }

  clock(perfMs: number, contextTime: number): void {
    this.calls.push(["clock", perfMs, contextTime]);
  }

  stats(): EncodeStats {
    return { enc_queue: 1, pre_encode_drops: 0, captured_fps: 15 };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.calls.push(["stop"]);
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  /** Fails as a reclaimed encoder does. */
  fail(code: "encoder_error" | "capture_error" = "encoder_error"): void {
    this.emit({ k: "error", code, detail: "fake" });
  }

  private after(ms: number, f: () => void): void {
    if (!this.stopped) this.timers.push(setTimeout(f, ms));
  }

  private pts(): number {
    return this.t0 === undefined ? 0 : Math.floor(performance.now() - this.t0);
  }

  config(): ConfigMsg {
    const r = this.ladder[this.out]!;
    return {
      t: "config",
      video: {
        codec: "avc1.42E01F",
        w: r.w,
        h: r.h,
        fps: r.fps,
        bitrate_kbps: r.video_kbps,
        annexb: true,
        container: null,
        mirrored: false,
        rotation: 0,
        gop_ms: this.gop,
      },
      audio: {
        codec: "opus",
        sample_rate: 48000,
        channels: 1,
        bitrate_kbps: r.audio_kbps,
        frame_ms: 20,
        echo_cancellation: false,
      },
      rung: this.out,
      clock_source: "shared",
    };
  }

  private video(): void {
    const r = this.ladder[this.rungIn]!;
    this.after(1000 / r.fps, () => this.video());
    const now = performance.now();
    if (now - this.lastKey >= this.gop) this.key = true;
    const n = this.n++;
    const skip = this.dec === 1 ? n % 4 === 3 : this.dec === 2 && n % 2 === 1;
    if (skip && !this.key) return;
    const key = this.key;
    this.key = false;
    if (key) this.lastKey = now;
    const rc = this.barrier;
    this.barrier = false;
    if (rc) {
      this.out = this.rungIn;
      this.pending = true;
    }
    const bytes = Math.round((r.video_kbps * 125) / r.fps) * (key ? 5 : 1);
    this.emit({
      k: "chunk",
      track: "video",
      data: new Uint8Array(bytes),
      ptsMs: this.pts(),
      key,
      ps: key,
      rc,
      rung: this.out,
      ...(this.pending ? { config: this.config() } : {}),
    });
    this.pending = false;
    this.sentVideo = true;
  }

  private sound(): void {
    this.after(20, () => this.sound());
    if (!this.sentVideo) return;
    const r = this.ladder[this.out]!;
    this.emit({
      k: "chunk",
      track: "audio",
      data: new Uint8Array(Math.round((r.audio_kbps * 125) / 50)),
      ptsMs: this.pts(),
      key: false,
      ps: false,
      rc: false,
      rung: this.out,
    });
  }
}

/** A pipeline factory for EngineOptions.pipeline. */
export const fakePipeline = (m: InitMsg, emit: (e: EncodeEvent) => void) =>
  new FakePipeline(m, emit);

/**
 * A Worker whose behaviour the test sets per construction in `FakeWorker.script`:
 * `ready` posts engine-ready after `delay` ms, `silent` never answers, `error` fires an
 * error event, `throw` makes the constructor throw.
 */
export class FakeWorker {
  static all: FakeWorker[] = [];
  static script: ("ready" | "silent" | "error" | "throw")[] = [];
  static delay = 10;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessageerror: ((e: Event) => void) | null = null;
  terminated = false;
  posted: [ToEngine, Transferable[]][] = [];

  constructor(
    readonly url: string | URL,
    readonly options?: WorkerOptions,
  ) {
    const mode = FakeWorker.script.shift() ?? "ready";
    if (mode === "throw")
      throw new DOMException("blocked by CSP", "SecurityError");
    FakeWorker.all.push(this);
    if (mode === "ready")
      setTimeout(
        () =>
          this.send({
            k: "engine-ready",
            caps: { mstp: true, videoEncoder: true, audioEncoder: true },
          }),
        FakeWorker.delay,
      );
    if (mode === "error") setTimeout(() => this.crash(), FakeWorker.delay);
  }

  postMessage(m: ToEngine, transfer: Transferable[] = []): void {
    this.posted.push([m, transfer]);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The engine posts `m`. */
  send(m: FromEngine): void {
    if (!this.terminated) this.onmessage?.({ data: m } as MessageEvent);
  }

  /** An uncaught error in the worker. */
  crash(): void {
    if (this.terminated) return;
    const e = new Event("error", { cancelable: true });
    this.onerror?.(e);
  }
}
