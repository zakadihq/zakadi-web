// spec/06-web-sdk.md 6.3 and spec/05-sdk-contract.md 5.5: the profile, the audio path
// and the video source, detected on the main thread before consent and never reused
// across sessions.
import type { ErrorCode } from "@zakadi/protocol";
import type { QuirkCaps } from "./device";

/** The audio paths of 6.2.4, in the order pickAudio tries them. */
export type AudioPath =
  | "webcodecs-mstp"
  | "webcodecs-worklet"
  | "recorder-opus"
  | "recorder-aac"
  | "none";

/**
 * How the engine receives camera frames (6.3): a transferred MSTP stream (Chromium),
 * a transferred track clone (MSTP in the worker, Safari 18+) or rVFC frames.
 */
export type VideoSourceKind = "readable" | "track" | "frames";

export type Detection =
  | {
      profile: "webcodecs";
      /** The first candidate isConfigSupported accepted. */
      video: VideoEncoderConfig;
      /** isConfigSupported per codec, both codecs always checked (camera_meta.encoder). */
      supported: Record<string, boolean>;
      /** A prefer-hardware candidate was accepted (hello.caps.hw_encode). */
      hw: boolean;
      audio: AudioPath;
    }
  | { profile: "mediarecorder"; mime: string };

/** A failure carrying its 6.10 SDK error code; the message names the cause. */
export type Failure = Error & { code: ErrorCode };

export const fail = (code: ErrorCode, reason: string): Failure =>
  Object.assign(new Error(reason), { code });

const RECORDER_TYPES = [
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
  "video/mp4",
];

/**
 * Detects the profile (6.3). `candidates` are the 6.2.4 encoder configurations at the
 * rung 0 size, in their order; `caps` are the matched device_quirks caps, whose
 * `profile: "mediarecorder"` forces that profile. Rejects with a Failure: `internal` in
 * an insecure context, `unsupported_device` without a camera API, WebSocket, encoder
 * or recorder type.
 */
export async function detect(
  candidates: readonly VideoEncoderConfig[],
  caps: QuirkCaps,
): Promise<Detection> {
  if (!isSecureContext) throw fail("internal", "insecure_context");
  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof WebSocket !== "function"
  ) {
    throw fail("unsupported_device", "no_camera_api");
  }
  if (
    caps.profile !== "mediarecorder" &&
    typeof VideoEncoder === "function" &&
    typeof VideoFrame === "function"
  ) {
    const ok = await Promise.all(
      candidates.map((c) =>
        VideoEncoder.isConfigSupported(c).then(
          (r) => !!r.supported,
          () => false,
        ),
      ),
    );
    const first = ok.indexOf(true);
    if (first >= 0) {
      const supported: Record<string, boolean> = {};
      let hw = false;
      candidates.forEach((c, i) => {
        supported[c.codec] = !!(supported[c.codec] || ok[i]);
        hw ||= !!ok[i] && c.hardwareAcceleration === "prefer-hardware";
      });
      return {
        profile: "webcodecs",
        video: candidates[first]!,
        supported,
        hw,
        audio: await pickAudio(),
      };
    }
  }
  const mime =
    typeof MediaRecorder === "function" &&
    RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  if (mime) return { profile: "mediarecorder", mime };
  throw fail("unsupported_device", "no_encoder");
}

/** The audio path of the webcodecs profile, in 6.3 order. */
export async function pickAudio(): Promise<AudioPath> {
  const rec = typeof MediaRecorder === "function";
  if (
    typeof AudioEncoder === "function" &&
    (await AudioEncoder.isConfigSupported({
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: 24000,
    }).then(
      (r) => r.supported,
      () => false,
    ))
  ) {
    return typeof MediaStreamTrackProcessor === "function"
      ? "webcodecs-mstp"
      : "webcodecs-worklet";
  }
  if (rec && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
    return "recorder-opus";
  }
  if (rec && MediaRecorder.isTypeSupported("audio/mp4")) return "recorder-aac";
  return "none";
}

/**
 * The video source kind (6.3): the MSTP stream where the main thread has MSTP, a track
 * clone where only the engine's worker has it (`engineMstp`, from engine-ready), else
 * rVFC frames. A track the browser cannot transfer falls back to frames in sendVideo.
 */
export const videoSourceKind = (engineMstp: boolean): VideoSourceKind =>
  typeof MediaStreamTrackProcessor === "function"
    ? "readable"
    : engineMstp
      ? "track"
      : "frames";
