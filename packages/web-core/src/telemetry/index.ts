// Telemetry (spec/05-sdk-contract.md 5.12, spec/06-web-sdk.md 6.2.10, spec/02-api.md
// 2.10): each event goes synchronously to the host's sink and is posted in batches
// to POST /v1/telemetry as text/plain, so neither fetch nor sendBeacon needs a
// preflight.
import type { HelloMsg } from "@zakadi/protocol";

/** The events of 5.12 and the web additions of 6.2.10. */
export type TelemetryName =
  | "sdk_start"
  | "consent_shown"
  | "consent_result"
  | "permission_result"
  | "pack_fetch"
  | "connect"
  | "probe"
  | "rung_change"
  | "stats"
  | "cue_play"
  | "cue_missing"
  | "ui_state"
  | "keyframe_request"
  | "orientation_unlocked"
  | "config_unavailable"
  | "end"
  | "error"
  | "engine_host"
  | "encoder_unrecognised"
  | "tile_latency_ms"
  | "clock_source";

/** Short scalars only: never media, landmarks, tokens or user identifiers (5.12, 2.10). */
export type Fields = Record<string, string | number | boolean | null>;

/** One event, as the host's sink receives it and the endpoint stores it. */
export interface TelemetryEvent {
  name: TelemetryName;
  /** Milliseconds since `sdk_start` on the monotonic clock, not the media clock (D47). */
  t_ms: number;
  fields: Fields;
}

export interface TelemetryOptions {
  /** The session id the endpoint files the events under. */
  sessionId: string;
  /** The `sdk` object of `hello`. */
  sdk: HelloMsg["sdk"];
  /** The host's `telemetrySink`, called synchronously with every event. */
  sink?: ((event: TelemetryEvent) => void) | undefined;
  /** The `telemetryEndpoint` option: false posts nothing. */
  endpoint?: string | false | undefined;
}

export interface Telemetry {
  emit(name: TelemetryName, fields?: Fields): void;
  /** Posts what is left, then stops posting; the sink still receives later events. */
  dispose(): void;
}

const ENDPOINT = "https://api.zakadi.dev/v1/telemetry";
// 2.10: at most 100 events and 32 KB per call, read as 32,000 bytes of body.
const MAX_EVENTS = 100;
const MAX_BYTES = 32000;
const EVERY_MS = 5000;

/**
 * Starts the telemetry of one session: `sdk_start` is emitted at once and is the
 * origin of every `t_ms`. Batches post every 5 s with a keepalive fetch and on
 * `pagehide` with `navigator.sendBeacon`; `stats` is sampled one in five.
 */
export function createTelemetry(options: TelemetryOptions): Telemetry {
  const t0 = performance.now();
  const encoder = new TextEncoder();
  const head =
    '{"session_id":' +
    JSON.stringify(options.sessionId) +
    ',"sdk":' +
    JSON.stringify(options.sdk) +
    ',"events":[';
  const headBytes = encoder.encode(head).length + 2;
  // Each queued event as its JSON and its size in bytes.
  const queue: [string, number][] = [];
  let url = options.endpoint ?? ENDPOINT;
  let stats = 0;

  const post = (beacon: boolean): void => {
    while (url && queue.length) {
      let body = head;
      let bytes = headBytes;
      let n = 0;
      for (const [json, size] of queue) {
        if (n === MAX_EVENTS || bytes + size + 1 > MAX_BYTES) break;
        body += (n++ ? "," : "") + json;
        bytes += size + 1;
      }
      // An event over the byte limit on its own is dropped.
      queue.splice(0, n || 1);
      if (!n) continue;
      body += "]}";
      if (beacon) navigator.sendBeacon(url, body);
      else
        fetch(url, {
          method: "POST",
          body,
          headers: { "content-type": "text/plain" },
          keepalive: true,
          credentials: "omit",
        }).catch(() => undefined);
    }
  };
  const onPageHide = (): void => post(true);
  const timer = url ? setInterval(() => post(false), EVERY_MS) : undefined;
  if (url) globalThis.addEventListener?.("pagehide", onPageHide);

  const emit = (name: TelemetryName, fields: Fields = {}): void => {
    if (name === "stats" && stats++ % 5) return;
    const event = { name, t_ms: Math.round(performance.now() - t0), fields };
    const json = JSON.stringify(event);
    if (url) queue.push([json, encoder.encode(json).length]);
    try {
      options.sink?.(event);
    } catch {
      // The host's sink never stops the session.
    }
  };
  emit("sdk_start");

  return {
    emit,
    dispose() {
      post(false);
      clearInterval(timer);
      globalThis.removeEventListener?.("pagehide", onPageHide);
      url = false;
    },
  };
}
