// spec/06-web-sdk.md 6.2.3 and 6.10, spec/05-sdk-contract.md 5.1 and 5.3: the one
// getUserMedia call after consent, the preview on the original tracks and the exposure
// request after the probe.
import type { ErrorCode } from "@zakadi/protocol";
import type { QuirkCaps } from "../detect/device";
import { fail, type Failure } from "../detect/profile";

export interface Camera {
  /** The getUserMedia stream: its original tracks feed the preview and the probe. */
  stream: MediaStream;
  video: MediaStreamVideoTrack;
  audio: MediaStreamAudioTrack | undefined;
  /** The session video constraints, which the probe restores (applyConstraints replaces the set). */
  constraints: MediaTrackConstraints;
  /** What closeCamera runs besides stopping the originals: the engine's clones and audio nodes. */
  stops: (() => void)[];
}

export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 16000 },
};

const CODES: Record<string, ErrorCode> = {
  NotAllowedError: "permission_denied",
  NotFoundError: "unsupported_device",
  OverconstrainedError: "unsupported_device",
  NotReadableError: "capture_error",
  AbortError: "capture_error",
};

/** The 6.10 SDK error for a getUserMedia failure; anything unlisted is `capture_error`. */
export const mediaErrorCode = (e: unknown): ErrorCode =>
  CODES[(e as Error)?.name] ?? "capture_error";

/**
 * Opens the front camera and the microphone (6.2.3): call once, after consent, never
 * before. `caps.max_fps` caps the frame rate. A camera whose settings say
 * `environment` is stopped and a `user` one is requested instead; a camera that
 * reports no facingMode is accepted. Rejects with a Failure carrying the 6.10 code,
 * every track it opened stopped.
 */
export async function openCamera(caps: QuirkCaps = {}): Promise<Camera> {
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  if (nav.audioSession) nav.audioSession.type = "play-and-record"; // Safari 16.4+
  const constraints: MediaTrackConstraints = {
    facingMode: "user",
    width: { ideal: 480 },
    height: { ideal: 640 },
    frameRate: { ideal: Math.min(30, caps.max_fps ?? 30) },
  };
  const media = navigator.mediaDevices;
  let stream: MediaStream | undefined;
  try {
    stream = await media.getUserMedia({
      video: constraints,
      audio: AUDIO_CONSTRAINTS,
    });
    let [video] = stream.getVideoTracks();
    if (video?.getSettings().facingMode === "environment") {
      video.stop();
      constraints.facingMode = { exact: "user" };
      [video] = (
        await media.getUserMedia({ video: constraints })
      ).getVideoTracks();
      stream = new MediaStream([video!, ...stream.getAudioTracks()]);
      if (video?.getSettings().facingMode !== "user") {
        throw fail("unsupported_device", "no_front_camera");
      }
    }
    return {
      stream,
      video: video!,
      audio: stream.getAudioTracks()[0],
      constraints,
      stops: [],
    };
  } catch (e) {
    stream?.getTracks().forEach((t) => t.stop());
    // A DOMException has a numeric legacy `code`; a Failure's is the 6.10 string.
    throw typeof (e as Failure).code === "string"
      ? e
      : fail(mediaErrorCode(e), (e as Error).name);
  }
}

/** Shows the original stream, muted and inline, in a preview element the UI or host owns. */
export function attachPreview(preview: HTMLVideoElement, camera: Camera) {
  preview.muted = preview.playsInline = preview.autoplay = true;
  preview.srcObject = camera.stream;
}

/**
 * After the probe (6.2.3, 5.3): continuous exposure metered on the oval centre and
 * +0.3 EV clamped to the reported range, each only where getCapabilities() lists it.
 */
export async function applyExposure(camera: Camera) {
  const c = camera.video.getCapabilities?.() as {
    exposureMode?: string[];
    exposureCompensation?: { min: number; max: number };
  };
  const set: Record<string, unknown> = {};
  if (c?.exposureMode?.includes("continuous")) {
    set.exposureMode = "continuous";
    set.pointsOfInterest = [{ x: 0.5, y: 0.45 }];
  }
  const ev = c?.exposureCompensation;
  if (ev) set.exposureCompensation = Math.min(ev.max, Math.max(ev.min, 0.3));
  if (Object.keys(set).length) {
    await camera.video
      .applyConstraints({ ...camera.constraints, advanced: [set] })
      .catch(() => {});
  }
}

/** Stops the original tracks, the clones given to the engine and the capture audio nodes. */
export function closeCamera(camera: Camera) {
  camera.stream.getTracks().forEach((t) => t.stop());
  camera.stops.splice(0).forEach((stop) => stop());
}
