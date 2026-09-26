// The engine (spec/06-web-sdk.md 6.2.1): capture frames to encoders to the zakadi.v1
// transport, driven by ToEngine messages and reporting FromEngine ones. The same code
// runs in the dedicated worker (engine.worker.ts) and inline on the main thread.
import type { ByeMsg } from "@zakadi/protocol";
import { createEncoder } from "../encode/pipeline";
import type { EncodeEvent, Pipeline } from "../encode/types";
import {
  connect,
  type Socket,
  type Transport,
  type TransportEvent,
} from "../transport/client";
import { adapt, type Adapted } from "./media";
import type { FromEngine, InitMsg, ToEngine } from "./messages";

type SocketClass = new (url: string, protocols: string[]) => Socket;
type Make = (m: InitMsg, emit: (e: EncodeEvent) => void) => Pipeline;

export interface EngineOptions {
  /** The WebSocket constructor; the platform's by default. */
  WebSocket?: SocketClass | undefined;
  /** Makes the pipeline `init` asks for; the WebCodecs encoder by default. */
  pipeline?: Make | undefined;
}

export interface Engine {
  handle(m: ToEngine): void;
  /** Stops media and closes the socket at once, without a bye. */
  terminate(): void;
}

/** The `webcodecs` profile's pipeline (6.2.4). */
export const encoderPipeline: Make = (m, emit) =>
  createEncoder({
    video: m.video,
    audio: m.audio,
    emit,
    ...(m.preferSoftware ? { preferSoftware: true } : {}),
    ...(m.settings ? { settings: m.settings } : {}),
  });

/** Starts an engine that posts `engine-ready` at once and then serves `handle`. */
export function createEngine(
  post: (m: FromEngine) => void,
  o: EngineOptions = {},
): Engine {
  const make = o.pipeline ?? encoderPipeline;
  let media: Adapted | undefined;
  let transport: Transport | undefined;
  // performance.timeOrigin of the main thread, from init.
  let origin = performance.timeOrigin;
  let opened = false;
  let ended = false;
  let closed = false;
  let failed = false;
  let queued = false; // a bye was handed to the transport
  let out = false; // a bye went out on the socket
  let closing = false; // close once the bye is out

  // The socket as the transport sees it: it observes the bye going out, so that `stop`
  // closes right after the final attest and bye (6.10).
  const Base = (o.WebSocket ?? WebSocket) as SocketClass;
  class Tap extends Base {
    send(d: string | ArrayBuffer): void {
      super.send(d);
      if (typeof d === "string" && d.startsWith('{"t":"bye"')) {
        out = true;
        if (closing) this.close(1000);
      }
    }
  }

  const bye = (m: ByeMsg) => {
    queued = true;
    transport!.send(m);
  };

  // Capture or encoding failed: the bye, then the fatal (6.8, 6.10).
  const fail = (code: "encoder_error" | "capture_error") => {
    if (failed || ended || closed) return;
    failed = true;
    media?.stop();
    if (opened && !queued) bye({ t: "bye", reason: code });
    post({ k: "fatal", code });
  };

  const emit = (e: TransportEvent) => {
    switch (e.k) {
      case "open":
        opened = true;
        break;
      case "server":
        // The next camera frame starts the media clock (6.2.5).
        if (e.msg.t === "ready") media?.pipeline.ready(e.msg);
        if (e.msg.t === "end") {
          ended = true;
          media?.stop();
        }
        break;
      case "first-media": {
        const source = media?.describe().clock_source;
        post({
          k: "telemetry",
          name: "clock_source",
          fields: { source: source ?? "shared" },
        });
        break;
      }
      case "keyframe_request":
        post({
          k: "telemetry",
          name: "keyframe_request",
          fields: { ms_to_idr: Math.round(e.ms_to_idr) },
        });
        return;
      case "fatal":
        failed = true;
        // network_floor: the transport sent `bye floor_breached` itself.
        queued ||= e.code === "network_floor";
        media?.stop();
        break;
      case "closed":
        closed = true;
        media?.stop();
        break;
    }
    post(e);
  };

  // Ends the engine: after the pending or given bye while the socket is open, else at once.
  const stop = (m?: ByeMsg) => {
    media?.stop();
    if (!transport || closed) return;
    if (opened && !ended && !out && (queued || m)) {
      closing = true;
      if (!queued) bye(m!);
    } else transport.close();
  };

  post({
    k: "engine-ready",
    caps: {
      mstp: typeof MediaStreamTrackProcessor === "function",
      videoEncoder: typeof VideoEncoder === "function",
      audioEncoder: typeof AudioEncoder === "function",
    },
  });

  return {
    terminate() {
      media?.stop();
      transport?.close();
    },
    handle(m) {
      switch (m.k) {
        case "init":
          origin = m.origin;
          media = adapt((e) => make(m, e), {
            t0: (perfMs) =>
              post({
                k: "media-clock",
                t0PerfMs: perfMs + performance.timeOrigin - origin,
              }),
            error: fail,
          });
          break;
        case "connect":
          if (!media || transport) break;
          transport = connect({
            WebSocket: Tap,
            ranked: m.ranked,
            hello: m.hello,
            cameraMeta: m.cameraMeta,
            jti: m.jti,
            media,
            ...(m.maxRung ? { maxRung: m.maxRung } : {}),
            emit,
          });
          break;
        case "client":
          if (m.msg.t !== "bye") transport?.send(m.msg);
          else if (!queued && opened && !ended && !closed) bye(m.msg);
          break;
        case "frame":
          if (media) media.pipeline.frame(m.frame);
          else m.frame.close();
          break;
        case "clock":
          if (m.ctxTime !== undefined)
            media?.pipeline.clock(
              m.perfMs + origin - performance.timeOrigin,
              m.ctxTime,
            );
          break;
        case "stop":
          stop(m.bye);
          break;
      }
    },
  };
}
