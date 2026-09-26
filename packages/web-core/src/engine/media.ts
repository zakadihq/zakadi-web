// The encoder-to-transport adapter (spec/06-web-sdk.md 6.2.4 to 6.2.7): the transport's
// Media over an encode Pipeline. Chunks keep their order and flags; the `config` a chunk
// carries becomes what describe() returns, since the transport writes `config` itself.
import type { EncodeEvent, Pipeline } from "../encode/types";
import type { Media, MediaConfig } from "../transport/media";

export interface MediaHooks {
  /** The media clock's origin, performance.now() in the engine (6.2.5). */
  t0(perfMs: number): void;
  /** Capture or encoding failed. */
  error(code: "encoder_error" | "capture_error", detail: string): void;
}

export interface Adapted extends Media {
  readonly pipeline: Pipeline;
}

/** Makes the pipeline with an emitter that feeds the transport, and wraps it as Media. */
export function adapt(
  make: (emit: (e: EncodeEvent) => void) => Pipeline,
  hooks: MediaHooks,
): Adapted {
  let out: Parameters<Media["start"]>[1] | undefined;
  let origin: number | null = null;
  let desc: MediaConfig | undefined;
  const pipeline = make((e) => {
    if (e.k === "chunk") {
      if (e.config) {
        const { video, audio, clock_source } = e.config;
        desc = { video, audio, ...(clock_source ? { clock_source } : {}) };
      }
      out?.({
        ...(e.track === "audio" ? { audio: true } : {}),
        data: e.data,
        ts: e.ptsMs,
        key: e.key,
        ps: e.ps,
        rung: e.rung,
      });
    } else if (e.k === "t0") {
      origin = e.perfMs;
      hooks.t0(e.perfMs);
    } else if (e.k === "error") hooks.error(e.code, e.detail);
    // `idr`: the transport measures keyframe_request itself (6.2.7 step 3).
  });
  return {
    pipeline,
    start(rung, o) {
      out = o;
      pipeline
        .start(rung.rung)
        .catch((x: unknown) => hooks.error("encoder_error", String(x)));
    },
    apply(rung, decimation) {
      pipeline.rung(rung.rung, decimation);
    },
    keyframe(kbps, ms) {
      pipeline.keyframe(kbps && ms ? { boost_kbps: kbps, boost_ms: ms } : {});
    },
    stop() {
      pipeline.stop();
    },
    describe() {
      return desc!;
    },
    origin() {
      return origin;
    },
    counters() {
      return pipeline.stats();
    },
  };
}
