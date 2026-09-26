// The camera probe of spec/01-protocol.md 1.4 `camera_meta`, spec/05-sdk-contract.md
// 5.9 and spec/06-web-sdk.md 6.2.3: after permission and before the socket opens, never
// after `hello`.
import type { CameraMetaMsg } from "@zakadi/protocol";
import { frameObserver, type FrameObserver } from "./observer";

export type ProbeEntry = CameraMetaMsg["probe"][number];

/** The 1.4 steps, most informative first; bare values are non-required constraints. */
export const STEPS = [
  { height: 3001 },
  { height: 11 },
  { height: 640 },
  { height: 240 },
  { height: 2001 },
  { height: 22 },
  { height: 1001 },
  { fps: 200 },
  { fps: 1 },
  { fps: 60 },
  { fps: 120 },
  { fps: 5 },
  { fps: 30 },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Applies the steps within 3 s, marking those not reached `skipped`, and records per
 * step the reported settings, what the observer saw over up to 3 frames or 400 ms,
 * `reconfig_ms` from the call to the first frame of the reported size (height steps)
 * or the first frame after the call resolves (frame rate steps), and `method`. Without
 * an observer, `observed` is the reported settings. Then restores `restore`, the
 * session constraints, and closes the observer.
 */
export async function cameraProbe(
  track: MediaStreamVideoTrack,
  restore: MediaTrackConstraints,
  observer: FrameObserver | undefined = frameObserver(track),
): Promise<ProbeEntry[]> {
  const deadline = performance.now() + 3000;
  const out: ProbeEntry[] = [];
  for (const request of STEPS) {
    const t0 = performance.now();
    const height = "height" in request;
    const applied =
      t0 < deadline &&
      (await Promise.race([
        track
          .applyConstraints(
            height ? { height: request.height } : { frameRate: request.fps },
          )
          .then(
            () => true,
            () => true,
          ),
        sleep(deadline - t0).then(() => false),
      ]));
    if (!applied) {
      out.push({ request, skipped: true });
      continue;
    }
    const s = track.getSettings();
    const reported = { w: s.width, h: s.height, fps: s.frameRate };
    const [observed, at] = observer
      ? await observer.collect(
          height ? reported : null,
          Math.min(400, deadline - performance.now()),
        )
      : [reported, performance.now()];
    out.push({
      request,
      reported,
      observed,
      ...(at === undefined ? {} : { reconfig_ms: Math.round(at - t0) }),
      method: observer?.method ?? "getSettings",
    });
  }
  observer?.close();
  await Promise.race([
    track.applyConstraints(restore).catch(() => {}),
    sleep(1000),
  ]);
  return out;
}
