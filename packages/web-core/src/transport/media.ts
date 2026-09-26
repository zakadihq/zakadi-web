import type { ConfigMsg, StatsMsg } from "@zakadi/protocol";
import type { Decimation, Rung } from "../control/loop";

// The media interface the transport drives (spec/06-web-sdk.md 6.2.6 and 6.2.7). The
// engine host implements it over capture and encode; the transport never touches a
// frame, only the chunks the encoders produce.

/** One encoded chunk, delivered in encode order per track. */
export interface Chunk {
  /** True for an audio packet or audio container chunk; otherwise video. */
  audio?: boolean;
  /**
   * Video: one Annex-B access unit, a VP8 frame or a recorder container chunk; audio:
   * one Opus or AAC packet, or a container chunk (01 1.3.2).
   */
  data: Uint8Array;
  /** Video: the cached SPS and PPS to put before `data` when the IDR lacks them. */
  prefix?: Uint8Array;
  /** pts_ms on the session media clock (01 1.3.3, 06 6.2.5). */
  ts: number;
  /** Video: an IDR or VP8 keyframe. */
  key?: boolean;
  /** Video: parameter sets precede the slice data, `prefix` included. */
  ps?: boolean;
  /**
   * The ladder rung the chunk was encoded at. The first video chunk at a new rung is
   * the switch barrier of 6.2.7 step 2.
   */
  rung: number;
}

/**
 * The codec side of `config` (01 1.4): the codec read from the SPS, `annexb`,
 * `container`, `gop_ms`, the audio codec, true sample rate and channels, and
 * `clock_source`. The transport adds the rung's size, frame rate and bitrates, and
 * `mirrored: false`, `rotation: 0`.
 */
export type MediaConfig = {
  video: Omit<
    ConfigMsg["video"],
    "w" | "h" | "fps" | "bitrate_kbps" | "mirrored" | "rotation"
  >;
  audio: Omit<ConfigMsg["audio"], "bitrate_kbps">;
} & Pick<ConfigMsg, "clock_source">;

/** The media counters of `stats` (6.2.6); `thermal` is omitted on the web (G7). */
export type MediaCounters = Pick<
  StatsMsg,
  "enc_queue" | "pre_encode_drops" | "captured_fps" | "battery_low"
>;

export interface Media {
  /** Starts capture and encoding at the start rung; every chunk goes to `out`. */
  start(rung: Rung, out: (c: Chunk) => void): void;
  /**
   * Applies a rung and a decimation from the next submitted frame, forcing a keyframe
   * there when the size changes; the audio encoder takes the rung's audio rate at the
   * first video chunk of the new rung (6.2.7 steps 1 and 2). The same rung again only
   * changes the decimation.
   */
  apply(rung: Rung, decimation: Decimation): void;
  /**
   * Encodes the next selected frame as a keyframe, bypassing decimation; with a boost,
   * caps the bitrate at `boostKbps` for `boostMs`, then restores the rung's (6.2.7 step 3).
   */
  keyframe(boostKbps?: number, boostMs?: number): void;
  /** Stops feeding the encoders; chunks already in flight may still arrive. */
  stop(): void;
  /** The codec side of `config`, valid from the first video chunk. */
  describe(): MediaConfig;
  /** The performance.now() time of the media clock's origin, or null before the first frame. */
  origin(): number | null;
  counters(): MediaCounters;
}
