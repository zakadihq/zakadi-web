import type { ConfigMsg, KeyframeMsg, ReadyMsg } from "@zakadi/protocol";

/** How camera frames reach the engine (spec/06-web-sdk.md 6.2.1, 6.3). */
export type VideoSource =
  /** Chromium: an MSTP stream transferred to the engine. */
  | { kind: "readable"; stream: ReadableStream<VideoFrame> }
  /** Safari 18+: a track clone, read through MSTP in the worker. */
  | { kind: "track"; track: MediaStreamTrack }
  /** Safari 16.4-17.x: frames from `requestVideoFrameCallback`, through `Pipeline.frame`. */
  | { kind: "frames" };

/** How microphone audio reaches the engine (6.2.1, 6.2.4). */
export type AudioSource =
  /** `webcodecs-mstp`: an MSTP stream of `AudioData`. */
  | { kind: "readable"; stream: ReadableStream<AudioData> }
  /** `webcodecs-worklet`: the port of `capture.worklet.js` and the context's sample rate. */
  | { kind: "pcm"; port: MessagePort; sampleRate: number }
  /** `recorder-opus` and `recorder-aac`: the port of `recordAudio`. */
  | { kind: "recorder"; port: MessagePort; container: "mp4" | "webm" }
  | { kind: "none" };

/**
 * One encoded video access unit, audio packet or recorder chunk, in output order. The flags
 * and `rung` are those of the 8-byte header (spec/01-protocol.md 1.3.1).
 */
export interface Chunk {
  k: "chunk";
  track: "video" | "audio";
  /** The payload: Annex-B with 4-byte start codes, a VP8 frame, an Opus packet or container bytes. */
  data: Uint8Array;
  /** The capture timestamp on the session media clock, in ms; never decreases per track. */
  ptsMs: number;
  /** An IDR, or a VP8 key frame. */
  key: boolean;
  /** SPS and PPS precede the slices. */
  ps: boolean;
  /**
   * The first video chunk of a new rung, the barrier of 6.2.7: send `rung`, then `config`,
   * then this chunk with `rung_changed`. The first audio message after it is the transport's
   * to flag.
   */
  rc: boolean;
  /** The ladder rung the chunk was encoded at. */
  rung: number;
  /** The `config` to send before this chunk: before the first media and after every reconfiguration. */
  config?: ConfigMsg;
}

export type EncodeEvent =
  | Chunk
  /** The media clock origin: the capture time of its first frame, as `performance.now()` in the engine. */
  | { k: "t0"; perfMs: number }
  /** A requested keyframe came out: telemetry `keyframe_request {ms_to_idr}` (6.2.7). */
  | { k: "idr"; ms: number }
  | { k: "error"; code: "encoder_error" | "capture_error"; detail: string };

/** The encoder counters of `stats` (6.2.6). */
export interface EncodeStats {
  enc_queue: number;
  pre_encode_drops: number;
  captured_fps: number;
}

/** What the protocol client drives (6.2.4, 6.2.5, 6.2.7). */
export interface Pipeline {
  /** `ready` arrived: the next frame starts the media clock. */
  ready(msg: Pick<ReadyMsg, "ladder" | "gop_ms">): void;
  /** After `probe_result`: configure the encoders at a rung of the ladder and start encoding. */
  start(rung: number): Promise<void>;
  /** Moves to a rung and a decimation (0 keeps every frame, 1 drops every 4th, 2 every 2nd). */
  rung(rung: number, decimation: 0 | 1 | 2): void;
  /** A server `keyframe`: an IDR on the next selected frame, at `boost_kbps` for `boost_ms`. */
  keyframe(msg: Pick<KeyframeMsg, "boost_kbps" | "boost_ms">): void;
  /** A frame of the `frames` video source. */
  frame(frame: VideoFrame): void;
  /** A `getOutputTimestamp()` pair of the capture `AudioContext`, `perfMs` in the engine's clock. */
  clock(perfMs: number, contextTime: number): void;
  stats(): EncodeStats;
  /** Stops encoding and releases the encoders, readers and recorders. */
  stop(): void;
}
