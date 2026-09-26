// The messages between the main thread and the engine (spec/06-web-sdk.md 6.2.1), the
// same whether the engine runs in a dedicated worker or inline on the main thread.
// Times cross between the two on performance.timeOrigin: each side keeps its own clock.
import type {
  AudioStateMsg,
  ByeMsg,
  CameraMetaMsg,
  ErrorCode,
  HelloMsg,
  RungMsg,
  StatsMsg,
  UiEventMsg,
} from "@zakadi/protocol";
import type { AudioSource, VideoSource } from "../encode/types";
import type { SessionMsg } from "../transport/client";
import type { IngestCandidate } from "../transport/rank";

/** The capture profile detected on the main thread (6.3). */
export type Profile = "webcodecs" | "mediarecorder";

/** What the engine's global scope offers, from `engine-ready`. */
export interface EngineCaps {
  /** MediaStreamTrackProcessor: a transferred track can be read there (Safari 18+). */
  mstp: boolean;
  videoEncoder: boolean;
  audioEncoder: boolean;
}

export interface InitMsg {
  k: "init";
  profile: Profile;
  video: VideoSource;
  audio: AudioSource;
  /** performance.timeOrigin of the main thread, to map times across (6.2.5). */
  origin: number;
  /** The microphone's getSettings(), reported in `config.audio`. */
  settings?: MediaTrackSettings | undefined;
  /** device_quirks `prefer_software_encoder` (D94). */
  preferSoftware?: boolean | undefined;
  /** The `mediarecorder` profile, always inline (6.1.4): the stream and its type. */
  recorder?: { stream: MediaStream; mime: string } | undefined;
}

export interface ConnectMsg {
  k: "connect";
  ranked: IngestCandidate[];
  /** The only message that carries the token (6.9). */
  hello: HelloMsg;
  cameraMeta: CameraMetaMsg;
  /** The 16 raw bytes of the token's `jti` claim, for the hash chain. */
  jti: Uint8Array;
  /** device_quirks `max_rung`. */
  maxRung?: number | undefined;
}

export type ToEngine =
  | InitMsg
  | ConnectMsg
  | { k: "client"; msg: AudioStateMsg | UiEventMsg | ByeMsg }
  /** A frame of the rVFC path, transferred. */
  | { k: "frame"; frame: VideoFrame }
  /** A getOutputTimestamp() pair of the capture AudioContext, on the main thread's clock. */
  | { k: "clock"; perfMs: number; ctxTime?: number }
  /** Ends the engine: `bye` first when given and the socket is open, then the close. */
  | { k: "stop"; bye?: ByeMsg };

export type FromEngine =
  | { k: "engine-ready"; caps: EngineCaps }
  | { k: "open"; region: string; ms: number }
  /** The media clock's origin on the main thread's performance clock. */
  | { k: "media-clock"; t0PerfMs: number }
  | { k: "first-media" }
  | { k: "server"; msg: SessionMsg }
  | { k: "rung"; from: number; to: number; reason: RungMsg["reason"] }
  | { k: "stats"; s: StatsMsg }
  /** Telemetry measured in the engine (6.2.10); fields are short scalars. */
  | {
      k: "telemetry";
      name: "keyframe_request" | "clock_source";
      fields: Record<string, string | number>;
    }
  | { k: "fatal"; code: ErrorCode }
  | { k: "closed"; code: number; reason: string };
