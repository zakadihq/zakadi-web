// `hello.caps` (spec/01-protocol.md 1.4, spec/06-web-sdk.md 6.2.6): the codecs that passed
// isConfigSupported, the audio path's codec, `hw_encode`, the two WebCodecs-only
// capabilities, and the camera's largest size in portrait and frame rate.
import type { HelloMsg } from "@zakadi/protocol";
import type { AudioPath, Detection } from "../detect/profile";

export function helloCaps(
  det: Detection,
  audio: AudioPath,
  video: MediaStreamTrack,
): HelloMsg["caps"] {
  const c = (video.getCapabilities?.() ?? {}) as {
    width?: { max?: number };
    height?: { max?: number };
    frameRate?: { max?: number };
  };
  const w = c.width?.max;
  const h = c.height?.max;
  const fps = c.frameRate?.max;
  const size = {
    ...(w && h
      ? { max_resolution: { w: Math.min(w, h), h: Math.max(w, h) } }
      : {}),
    ...(fps ? { max_fps: fps } : {}),
  };
  if (det.profile === "mediarecorder") {
    // One recorder with its audio muxed in: the container names both codecs (6.2.4).
    const mp4 = det.mime.includes("mp4");
    return {
      profile: "mediarecorder",
      video: [mp4 ? "avc1.42E01F" : "vp8"],
      audio: [mp4 ? "aac" : "opus"],
      hw_encode: false,
      keyframe_on_demand: false,
      bitrate_reconfig: false,
      ...size,
      attestation: "none",
    };
  }
  return {
    profile: "webcodecs",
    video: Object.keys(det.supported).filter((k) => det.supported[k]),
    // No audio path: an empty list, and the server decides (6.3).
    audio: audio === "none" ? [] : [audio === "recorder-aac" ? "aac" : "opus"],
    hw_encode: det.hw,
    keyframe_on_demand: true,
    bitrate_reconfig: true,
    ...size,
    attestation: "none",
  };
}
