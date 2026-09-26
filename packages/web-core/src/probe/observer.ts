// The FrameObserver of spec/06-web-sdk.md 6.2.3: frame sizes and times of a clone of
// the probed track, through MediaStreamTrackProcessor where the main thread has it,
// else requestVideoFrameCallback on a hidden video.
import { onFrames } from "../capture/sources";

/** A probe entry's `observed`: the last frame's size and the frame rate, or null. */
export type Observed = {
  w: number | null;
  h: number | null;
  fps: number | null;
};

export interface FrameObserver {
  /** How `observed` is measured (camera_meta probe `method`). */
  method: "mstp" | "rvfc";
  /**
   * Resolves after 3 frames or `timeoutMs` with what it saw and performance.now() at
   * the first frame counted. With `size`, frames count from the first of that size,
   * in either orientation. `fps` is 1000 x (n - 1) / (t_last - t_first) over the
   * counted frames' timestamps, null below 2 frames.
   */
  collect(
    size: { w: number | undefined; h: number | undefined } | null,
    timeoutMs: number,
  ): Promise<[Observed, number | undefined]>;
  close(): void;
}

type Emit = (ms: number, w: number, h: number) => void;

function observer(
  method: FrameObserver["method"],
  attach: (emit: Emit) => () => void,
): FrameObserver {
  let sink: Emit | undefined;
  const close = attach((ms, w, h) => sink?.(ms, w, h));
  const collect: FrameObserver["collect"] = (size, timeoutMs) =>
    new Promise((resolve) => {
      const seen: Observed = { w: null, h: null, fps: null };
      const times: number[] = [];
      let at: number | undefined;
      const done = () => {
        sink = undefined;
        clearTimeout(timer);
        const span = times[times.length - 1]! - times[0]!;
        if (span > 0)
          seen.fps = Math.round((1e4 * (times.length - 1)) / span) / 10;
        resolve([seen, at]);
      };
      const timer = setTimeout(done, timeoutMs);
      sink = (ms, w, h) => {
        seen.w = w;
        seen.h = h;
        if (at === undefined) {
          if (
            size &&
            !((w === size.w && h === size.h) || (w === size.h && h === size.w))
          ) {
            return;
          }
          at = performance.now();
        }
        if (times.push(ms) === 3) done();
      };
    });
  return { method, collect, close };
}

/** An observer of a clone of `track`, or undefined where neither MSTP nor rVFC exists. */
export function frameObserver(
  track: MediaStreamVideoTrack,
): FrameObserver | undefined {
  const copy = track.clone();
  if (typeof MediaStreamTrackProcessor === "function") {
    return observer("mstp", (emit) => {
      const reader = new MediaStreamTrackProcessor({
        track: copy,
      }).readable.getReader();
      const read = (): Promise<void> =>
        reader.read().then(({ done, value }) => {
          if (done) return;
          emit(value.timestamp / 1000, value.displayWidth, value.displayHeight);
          value.close();
          return read();
        });
      read().catch(() => {});
      return () => {
        reader.cancel().catch(() => {});
        copy.stop();
      };
    });
  }
  const video = document.createElement("video");
  if (!("requestVideoFrameCallback" in video)) {
    copy.stop();
    return undefined;
  }
  return observer("rvfc", (emit) => {
    video.muted = video.playsInline = true;
    video.srcObject = new MediaStream([copy]);
    video.style.cssText = "position:fixed;top:0;width:1px;opacity:0";
    document.body.append(video);
    const stop = onFrames(video, (ms, meta) =>
      emit(ms, meta.width, meta.height),
    );
    video.play().catch(() => {});
    return () => {
      stop();
      video.remove();
      copy.stop();
    };
  });
}
