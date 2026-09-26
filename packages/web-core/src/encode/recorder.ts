// The MediaRecorder paths of spec/06-web-sdk.md 6.2.4, on the main thread: container chunks
// go out unmodified and the server demuxes them (spec/01-protocol.md 1.3.2).
import type { ConfigMsg } from "@zakadi/protocol";
import { audioFlags } from "./candidates.js";
import type { Rung } from "./candidates.js";
import { codecOf } from "./h264.js";
import type { EncodeEvent, Pipeline } from "./types.js";

/** The recorder timeslice: `start(200)`. */
export const TIMESLICE = 200;

/**
 * Starts a recorder and passes each chunk, in order, with the best estimate of its start:
 * the performance time of the recorder's `start` event plus the chunk's offset (6.2.5).
 */
function record(
  rec: MediaRecorder,
  onChunk: (data: ArrayBuffer, perfMs: number) => void,
  onStart?: (perfMs: number) => void,
): void {
  let start = 0;
  let n = 0;
  let queue = Promise.resolve();
  rec.onstart = () => {
    start = performance.now();
    onStart?.(start);
  };
  rec.ondataavailable = ({ data }) => {
    const at = start + TIMESLICE * n++;
    if (data.size)
      queue = queue.then(() => data.arrayBuffer()).then((b) => onChunk(b, at));
  };
  rec.start(TIMESLICE);
}

function halt(rec: MediaRecorder | undefined): void {
  if (rec && rec.state !== "inactive") rec.stop();
}

/**
 * The `recorder-opus` and `recorder-aac` audio paths (Safari before 26): serves the engine's
 * end of `port`. On `{ kbps }` it records the microphone clone at that bitrate for the rest of
 * the session (spec/05-sdk-contract.md 5.4) and posts each chunk as `{ t, d }`, `t` the chunk's
 * start as `performance.timeOrigin` plus `performance.now()`; `null` stops it.
 */
export function recordAudio(
  track: MediaStreamTrack,
  mimeType: string,
  port: MessagePort,
): void {
  let rec: MediaRecorder | undefined;
  const fail = (e: unknown): void => port.postMessage({ e: String(e) });
  port.onmessage = ({ data }: MessageEvent<{ kbps: number } | null>) => {
    if (!data) return halt(rec);
    if (rec) return;
    try {
      rec = new MediaRecorder(new MediaStream([track]), {
        mimeType,
        audioBitsPerSecond: data.kbps * 1000,
      });
      rec.onerror = (e) => fail((e as ErrorEvent).error ?? e.type);
      record(rec, (d, perfMs) =>
        port.postMessage({ t: performance.timeOrigin + perfMs, d }, [d]),
      );
    } catch (e) {
      fail(e);
    }
  };
}

export interface RecorderOptions {
  /** The camera and microphone stream. */
  stream: MediaStream;
  /** The profile's type, for example `video/webm;codecs=vp8,opus` (6.3). */
  mimeType: string;
  emit(e: EncodeEvent): void;
  /** The microphone's `getSettings()`, reported in `config.audio`. */
  settings?: MediaTrackSettings;
}

/**
 * The `mediarecorder` profile: one recorder on the full stream at the start rung's bitrates,
 * its chunks sent unmodified as type 0 messages. The media clock starts with the recorder;
 * `keyframe` is ignored and the rung never changes (6.2.7).
 */
export function createRecorder(o: RecorderOptions): Pipeline {
  const mp4 = o.mimeType.includes("mp4");
  let ladder: readonly Rung[] = [];
  let rung = 0;
  let rec: MediaRecorder | undefined;
  let t0 = 0;
  let last = 0;
  let first = true;

  function config(r: Rung, head: Uint8Array): ConfigMsg {
    return {
      t: "config",
      video: {
        codec: mp4 ? mp4Codec(head) : "vp8",
        w: r.w,
        h: r.h,
        fps: r.fps,
        bitrate_kbps: r.video_kbps,
        annexb: false,
        container: mp4 ? "mp4" : "webm",
        mirrored: false,
        rotation: 0,
      },
      audio: {
        codec: mp4 ? "aac" : "opus",
        sample_rate: mp4 ? (o.settings?.sampleRate ?? 48000) : 48000,
        channels: 1,
        bitrate_kbps: r.audio_kbps,
        muxed_in_video: true,
        ...audioFlags(o.settings ?? {}),
      },
      rung: r.rung,
      clock_source: "aligned",
    };
  }

  return {
    ready(msg) {
      ladder = msg.ladder;
    },

    async start(to) {
      const r = ladder[to];
      if (!r || rec) return;
      rung = to;
      rec = new MediaRecorder(o.stream, {
        mimeType: o.mimeType,
        videoBitsPerSecond: r.video_kbps * 1000,
        audioBitsPerSecond: r.audio_kbps * 1000,
      });
      rec.onerror = (e) =>
        o.emit({
          k: "error",
          code: "encoder_error",
          detail: String((e as ErrorEvent).error ?? e.type),
        });
      record(
        rec,
        (b, perfMs) => {
          if (rec?.state === "inactive") return;
          const data = new Uint8Array(b);
          last = Math.max(last, Math.floor(perfMs - t0));
          o.emit({
            k: "chunk",
            track: "video",
            data,
            ptsMs: last,
            key: false,
            ps: false,
            rc: false,
            rung,
            ...(first ? { config: config(r, data) } : {}),
          });
          first = false;
        },
        (perfMs) => {
          t0 = perfMs;
          o.emit({ k: "t0", perfMs });
        },
      );
    },

    rung() {},
    keyframe() {},
    frame(f) {
      f.close();
    },
    clock() {},

    stats() {
      const fps = o.stream.getVideoTracks()[0]?.getSettings().frameRate;
      return {
        enc_queue: 0,
        pre_encode_drops: 0,
        captured_fps: fps ?? ladder[rung]?.fps ?? 0,
      };
    },

    stop() {
      halt(rec);
    },
  };
}

/** The codec of an MP4 recording, from the avcC record of its first chunk. */
export function mp4Codec(head: Uint8Array): string {
  for (let i = 0; i + 8 <= head.length; i++) {
    // "avcC"
    if (
      head[i] === 0x61 &&
      head[i + 1] === 0x76 &&
      head[i + 2] === 0x63 &&
      head[i + 3] === 0x43
    ) {
      return codecOf(head.subarray(i + 4));
    }
  }
  return "avc1.42E01F";
}
