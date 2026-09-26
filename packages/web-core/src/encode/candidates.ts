import type { ReadyMsg } from "@zakadi/protocol";

/** One rung of the `ready` ladder. */
export type Rung = ReadyMsg["ladder"][number];

/** A video encoder configuration to try (spec/06-web-sdk.md 6.2.4). */
export interface Candidate {
  readonly codec: "avc1.42E01F" | "vp8";
  readonly hw: HardwareAcceleration;
  readonly bitrateMode: VideoEncoderBitrateMode;
}

/** The candidates of 6.2.4, in the order they are tried. */
export const CANDIDATES: readonly Candidate[] = [
  { codec: "avc1.42E01F", hw: "prefer-hardware", bitrateMode: "constant" },
  { codec: "avc1.42E01F", hw: "prefer-hardware", bitrateMode: "variable" },
  // Desktop software H.264: hw_encode false.
  { codec: "avc1.42E01F", hw: "no-preference", bitrateMode: "variable" },
  // The web-only fallback (spec/05-sdk-contract.md 5.4).
  { codec: "vp8", hw: "no-preference", bitrateMode: "variable" },
];

/**
 * The candidates in the order they are tried: `device_quirks` `prefer_software_encoder`
 * moves the `no-preference` H.264 candidate ahead of the hardware ones (D94).
 */
export function order(preferSoftware = false): Candidate[] {
  const [a, b, c, d] = CANDIDATES as [
    Candidate,
    Candidate,
    Candidate,
    Candidate,
  ];
  return preferSoftware ? [c, a, b, d] : [a, b, c, d];
}

/** The encoder configuration of a rung, at the rung's bitrate unless `kbps` says otherwise. */
export function videoConfig(
  r: Rung,
  c: Candidate,
  kbps = r.video_kbps,
): VideoEncoderConfig {
  return {
    codec: c.codec,
    width: r.w,
    height: r.h,
    // Both always: Safari before 17.4 emitted nothing in realtime mode without them.
    bitrate: kbps * 1000,
    framerate: r.fps,
    hardwareAcceleration: c.hw,
    bitrateMode: c.bitrateMode,
    // The UA may drop input frames to hold the rate; output is never dropped.
    latencyMode: "realtime",
    ...(c.codec === "vp8" ? {} : { avc: { format: "annexb" } }),
  };
}

/** Opus in raw 20 ms packets, mono, at a constant bitrate (6.2.4). */
export function audioConfig(
  sampleRate: number,
  kbps: number,
): AudioEncoderConfig {
  return {
    codec: "opus",
    sampleRate,
    numberOfChannels: 1,
    bitrate: kbps * 1000,
    bitrateMode: "constant",
    opus: {
      format: "opus",
      frameDuration: 20000,
      useinbandfec: false,
      usedtx: false,
    },
  };
}

/** The capture processing `config.audio` reports: what `getSettings()` returns (6.2.3, G7). */
export function audioFlags(s: MediaTrackSettings): {
  echo_cancellation: boolean;
  noise_suppression?: boolean;
  auto_gain?: boolean;
} {
  return {
    echo_cancellation: !!s.echoCancellation,
    ...(s.noiseSuppression === undefined
      ? {}
      : { noise_suppression: s.noiseSuppression }),
    ...(s.autoGainControl === undefined
      ? {}
      : { auto_gain: s.autoGainControl }),
  };
}

/** What `check` found. */
export interface Checked {
  /** The candidates the UA supports at every rung checked, in the order they are tried. */
  ok: Candidate[];
  /** `camera_meta.encoder` (spec/01-protocol.md 1.4). */
  encoder: {
    impl: "hardware" | "unknown";
    is_config_supported: Record<string, boolean>;
  };
  /** Members of the first accepted configuration the UA did not echo as given, for telemetry. */
  diff: string[];
}

/**
 * Checks every candidate with `VideoEncoder.isConfigSupported()` at every rung given: at
 * detection the rung 0 size, at configure time the `ready` ladder. H.264 and VP8 are both
 * always checked. Hardware acceleration is a hint, so `impl` is `hardware` only when the
 * accepted (first supported) candidate is a `prefer-hardware` one.
 */
export async function check(
  rungs: readonly Rung[],
  preferSoftware = false,
): Promise<Checked> {
  const ok: Candidate[] = [];
  const supported: Record<string, boolean> = {
    "avc1.42E01F": false,
    vp8: false,
  };
  let diff: string[] = [];
  for (const c of order(preferSoftware)) {
    let pass = rungs.length > 0;
    for (const r of rungs) {
      const config = videoConfig(r, c);
      const s = await VideoEncoder.isConfigSupported(config).catch(
        () => undefined,
      );
      if (!s?.supported) {
        pass = false;
        break;
      }
      if (!ok.length && r === rungs[0]) {
        const echo = (s.config ?? {}) as Record<string, unknown>;
        diff = Object.entries(config)
          .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(echo[k]))
          .map(([k]) => k);
      }
    }
    if (pass) {
      ok.push(c);
      supported[c.codec] = true;
    }
  }
  return {
    ok,
    encoder: {
      impl: ok[0]?.hw === "prefer-hardware" ? "hardware" : "unknown",
      is_config_supported: supported,
    },
    diff,
  };
}
