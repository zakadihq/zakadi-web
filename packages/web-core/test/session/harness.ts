// A browser for the session tests (spec/06-web-sdk.md 6.11) on Vitest's virtual clock,
// assembled from the fakes of the merged modules: getUserMedia and tracks (capture),
// Web Audio, fetch and Cache Storage (audio), the WebSocket (transport), and the
// engine's pipeline (engine). The engine runs inline, over the fake socket.
import type { ReadyMsg, ServerMsg } from "@zakadi/protocol";
import { loadVectors } from "@zakadi/protocol/vectors";
import { vi } from "vitest";
import { inlineHost } from "../../src/engine/inline";
import type { RendererBridge, RendererView } from "../../src/session/bridge";
import { createSession } from "../../src/session/session";
import type {
  ZakadiConfig,
  ZakadiEvent,
  ZakadiEventMap,
  ZakadiSession,
} from "../../src/session/types";
import type { TelemetryEvent } from "../../src/telemetry/index";
import {
  FakeAudioContext,
  FakeCacheStorage,
  fakeFetch,
  makePack,
  UA,
  type TestPack,
} from "../audio/fakes";
import {
  FakeProcessor,
  FakeStream,
  FakeTrack,
  FakeVideo,
  fakeGetUserMedia,
  type FakeTrackInit,
} from "../capture/fakes";
import { FakePipeline, fakePipeline } from "../engine/fakes";
import { FakeSocket, microtaskDigest } from "../transport/fakes";

export const sessions = loadVectors().sessions;
const happy = sessions.find((s) => s.meta.name === "happy-two-actions")!;
export const READY = structuredClone(
  happy.lines.flatMap((l) =>
    l.dir === "s2c" && "msg" in l && l.msg.t === "ready" ? [l.msg] : [],
  )[0] as ReadyMsg,
);
export const PROBE_RESULT = {
  t: "probe_result",
  goodput_kbps: 640,
  rtt_ms: 190,
  start_rung: 2,
} as const;

const b64url = (s: string) =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** An unsigned client token with the claims the SDK reads (02 2.2). */
export function token(sub = "ses_01J8TEST0000000000000001"): string {
  const jti = b64url(
    String.fromCharCode(...Array.from({ length: 16 }, (_, i) => i)),
  );
  return [
    b64url(JSON.stringify({ alg: "ES256", kid: "test" })),
    b64url(JSON.stringify({ sub, jti, aud: "ingest" })),
    "c2lnbmF0dXJl",
  ].join(".");
}

/** A MediaStreamTrack whose events reach listeners, and that the test can end or mute. */
export class EventTrack extends FakeTrack {
  private readonly target = new EventTarget();
  override addEventListener(type?: string, f?: EventListener): void {
    if (type && f) this.target.addEventListener(type, f);
  }
  override removeEventListener(type?: string, f?: EventListener): void {
    if (type && f) this.target.removeEventListener(type, f);
  }
  fire(type: "ended" | "mute" | "unmute"): void {
    if (type === "ended") this.readyState = "ended";
    this.target.dispatchEvent(new Event(type));
  }
}

/** An AudioContext with state events, whose analyser knows its context. */
export class EventAudioContext extends FakeAudioContext {
  private readonly target = new EventTarget();
  addEventListener(type: string, f: EventListener): void {
    this.target.addEventListener(type, f);
  }
  removeEventListener(type: string, f: EventListener): void {
    this.target.removeEventListener(type, f);
  }
  override createAnalyser() {
    return Object.assign(super.createAnalyser(), { context: this });
  }
  /** The platform changes the state, as an incoming call or a stop does. */
  become(state: string): void {
    (this as unknown as { state: string }).state = state;
    this.target.dispatchEvent(new Event("statechange"));
  }
}

/** `<zakadi-call>` as the session sees it: bindSession, unbindSession and remove. */
export class FakeRenderer {
  bridge: RendererBridge | null = null;
  readonly views: RendererView[] = [];
  readonly got: string[] = [];
  removed = false;
  requestFullscreen = vi.fn(async () => undefined);
  bindSession(b: RendererBridge): void {
    this.bridge = b;
    b.onView((v) => this.views.push(v));
    b.onUi((s) => this.got.push("ui " + s.phase));
    b.onTile((m, hsl) => this.got.push(`tile ${m.symbol} ${hsl.join(",")}`));
    b.onSay((m) => this.got.push("say " + m.id));
    b.onFeedback((m) => this.got.push("feedback " + m.code));
  }
  unbindSession(b: RendererBridge): void {
    if (this.bridge === b) this.bridge = null;
  }
  remove(): void {
    this.removed = true;
  }
}

/** Every cue of the transcripts, the terminal cues and the consent notice. */
const CUES: Record<string, number> = { "consent.recording_notice": 900 };
for (const s of sessions)
  for (const l of s.lines)
    if ("msg" in l && l.msg.t === "say") {
      CUES[l.msg.cue] = 800;
      for (const d of l.msg.params?.digits ?? []) CUES["digit." + d] = 400;
      if (l.msg.params?.count) CUES["count." + l.msg.params.count] = 400;
    }
for (const cue of [
  "done.thanks",
  "fail.one_more_step",
  "net.dropped",
  "net.slow",
  "end.cancelled",
  "end.error",
  "end.unsupported",
  "end.permission",
  "end.interrupted",
  "end.disabled",
])
  CUES[cue] = 700;

let base = 0;

export interface Options {
  config?: Partial<ZakadiConfig>;
  /** The GET /v1/sdk/config answer; null never answers. */
  sdkConfig?: Record<string, unknown> | null;
  /** getUserMedia rejects with this error. */
  gumError?: Error;
  userAgent?: string;
  track?: FakeTrackInit;
  /** Extra navigator fields. */
  nav?: Record<string, unknown>;
  /** No manifest is served. */
  noPack?: boolean;
  /** A second pack, in fr-CI. */
  french?: boolean;
  headless?: boolean;
  /** The worker probe of the page's own engine host. */
  hostFails?: boolean;
}

export type Harness = Awaited<ReturnType<typeof setup>>;

/** The page, then a session in it; nothing is started. */
export async function setup(o: Options = {}) {
  base++;
  const apiBase = `https://api${base}.zakadi.test`;
  const pack = await makePack({ cues: CUES });
  const fr: TestPack | undefined = o.french
    ? await makePack({ cues: CUES, lang: "fr-CI" })
    : undefined;
  vi.useFakeTimers();
  microtaskDigest();
  FakeSocket.all = [];
  FakePipeline.all = [];
  FakeAudioContext.created.length = 0;

  const files = new Map([...pack.files, ...(fr?.files ?? [])]);
  if (o.noPack) files.delete(pack.ref.url);
  const packFetch = fakeFetch(files);
  const calls: string[] = [];
  const sdkConfig =
    o.sdkConfig === undefined
      ? {
          min_version: "0.0.0",
          latest_version: "0.0.0",
          kill_switch: false,
          wrapper_min_version: {},
          message: null,
          protocol: ["zakadi.v1"],
          prompt_pack_cdn: "https://cdn.zakadi.test/packs/",
          probe: { count: 8, bytes: 8192 },
          ladder_version: 3,
          device_quirks: [],
        }
      : o.sdkConfig;
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith(apiBase + "/v1/sdk/config"))
      return sdkConfig === null
        ? new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          )
        : Promise.resolve(Response.json(sdkConfig));
    if (url.endsWith("/v1/probe"))
      return Promise.resolve(new Response(null, { status: 204 }));
    if (url.includes("/v1/telemetry"))
      return Promise.resolve(new Response(null, { status: 204 }));
    return packFetch(input, init);
  });

  const video = new EventTrack({
    kind: "video",
    label: "camera2 1, facing front",
    settings: { width: 480, height: 640, frameRate: 30, facingMode: "user" },
    capabilities: {
      width: { min: 1, max: 1280 },
      height: { min: 1, max: 720 },
      frameRate: { min: 1, max: 30 },
    },
    ...o.track,
  });
  const audio = new EventTrack({
    kind: "audio",
    settings: { sampleRate: 48000, echoCancellation: false },
  });
  const devices = new EventTarget();
  const media = Object.assign(devices, {
    getUserMedia: fakeGetUserMedia(o.gumError ?? [video, audio]),
    enumerateDevices: vi.fn(async () => [] as MediaDeviceInfo[]),
  });
  const permission = { state: "granted" as PermissionState };
  const wakeLocks: { released: boolean; release(): Promise<void> }[] = [];
  vi.stubGlobal("navigator", {
    userAgent: o.userAgent ?? UA.chrome,
    language: "en",
    mediaDevices: media,
    permissions: { query: vi.fn(async () => permission) },
    wakeLock: {
      request: vi.fn(async () => {
        const l = {
          released: false,
          release: async () => void (l.released = true),
        };
        wakeLocks.push(l);
        return l;
      }),
    },
    ...o.nav,
  });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("MediaStreamTrackProcessor", FakeProcessor);
  vi.stubGlobal(
    "VideoEncoder",
    class {
      static isConfigSupported = vi.fn(async (config: VideoEncoderConfig) => ({
        supported: true,
        config,
      }));
    },
  );
  vi.stubGlobal(
    "VideoFrame",
    class {
      close(): void {}
    },
  );
  vi.stubGlobal(
    "AudioEncoder",
    class {
      static isConfigSupported = async () => ({ supported: true });
    },
  );
  vi.stubGlobal("MediaRecorder", undefined);
  vi.stubGlobal("AudioContext", EventAudioContext);
  vi.stubGlobal("caches", new FakeCacheStorage());
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("location", { href: "https://rp.example/verify" });
  const page = new EventTarget();
  vi.stubGlobal("addEventListener", page.addEventListener.bind(page));
  vi.stubGlobal("removeEventListener", page.removeEventListener.bind(page));
  const appended: unknown[] = [];
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
    createElement: vi.fn((tag: string) =>
      tag === "video" ? new FakeVideo() : new FakeRenderer(),
    ),
    body: { append: (n: unknown) => appended.push(n) },
    documentElement: { requestFullscreen: vi.fn(async () => undefined) },
    exitFullscreen: vi.fn(async () => undefined),
  });
  vi.stubGlobal("document", doc);

  const events: ZakadiEvent[] = [];
  const telemetry: TelemetryEvent[] = [];
  const config: ZakadiConfig = {
    clientToken: token(),
    ingest: [
      {
        region: "eu-west-2",
        url: "wss://ingest-euw2.zakadi.test/v1/sessions/ses_01J8TEST0000000000000001/stream",
      },
    ],
    promptPack: pack.ref,
    sessionUi: {
      consent_copy: {
        "en-NG": {
          title: "A short video check",
          body: "Follow two prompts on camera.",
          recording_notice: "Two still frames are kept for 7 days.",
        },
        ...(fr
          ? {
              "fr-CI": {
                title: "Une courte verification video",
                body: "Suivez deux consignes.",
              },
            }
          : {}),
      },
      brand: { primary: "#0A5", logo_url: null },
      badge_text: null,
      packs: fr ? [pack.ref, fr.ref] : [pack.ref],
    },
    locale: "en-NG",
    ui: { mode: o.headless === false ? "default" : "headless" },
    apiBase,
    telemetryEndpoint: false,
    telemetrySink: (e) => telemetry.push(e),
    ...o.config,
  };
  const hosts: string[] = [];
  const renderer = o.headless === false ? new FakeRenderer() : undefined;
  const session = createSession(config, {
    host: async (h) => {
      hosts.push(h.profile);
      if (o.hostFails) throw new Error("no host");
      return inlineHost({ WebSocket: FakeSocket, pipeline: fakePipeline });
    },
  });
  const types = Object.keys({
    state_changed: 0,
    consent_given: 0,
    active: 0,
    redial_requested: 0,
    closed: 0,
    permission: 0,
    connected: 0,
    phase: 0,
    ended: 0,
    error: 0,
    disconnected: 0,
  } satisfies Record<keyof ZakadiEventMap, 0>) as (keyof ZakadiEventMap)[];
  for (const type of types)
    session.on(type, (e) => events.push({ type, ...e } as ZakadiEvent));
  if (renderer) session.attach(renderer as unknown as HTMLElement);

  return {
    session,
    config,
    pack,
    fr,
    events,
    telemetry,
    calls,
    fetch,
    video,
    audio,
    media,
    permission,
    wakeLocks,
    page,
    doc,
    appended,
    hosts,
    renderer,
    /** The socket the engine opened, once it exists. */
    sock: () => FakeSocket.all[FakeSocket.all.length - 1]!,
    pipeline: () => FakePipeline.last,
    ctx: () => FakeAudioContext.created.at(-1) as EventAudioContext | undefined,
    /** The event types, in order, optionally without state_changed. */
    types: (all = false) =>
      events
        .filter((e) => all || e.type !== "state_changed")
        .map((e) => e.type),
    telemetryNames: () => telemetry.map((e) => e.name),
    sent: () => FakeSocket.all.flatMap((s) => s.texts()),
  };
}

/** Advances the virtual clock in 10 ms steps until `cond` holds. */
export async function until(cond: () => boolean, max = 30000): Promise<void> {
  for (let t = 0; t < max && !cond(); t += 10)
    await vi.advanceTimersByTimeAsync(10);
  if (!cond()) throw new Error("until: the condition never held");
}

/** start() with its rejection kept; consent given in the headless bridge. */
/** The bridge that takes consent: the headless one, or the attached renderer's. */
const consentBridge = (h: Harness) => h.session.headless ?? h.renderer?.bridge;

export function begin(h: Harness, consent = true) {
  const started = h.session.start();
  const result: { ok?: boolean; error?: unknown } = {};
  started.then(
    () => (result.ok = true),
    (e: unknown) => {
      result.ok = false;
      result.error = e;
    },
  );
  const consented = consent
    ? until(() => h.session.state === "consent").then(() =>
        consentBridge(h)!.submitConsent(true, "en-NG", false),
      )
    : Promise.resolve();
  return { started, result, consented };
}

/** Up to the socket: consent, permission, the probe, ranking and the pack. */
export async function toSocket(h: Harness) {
  const b = begin(h);
  await b.consented;
  await until(() => FakeSocket.all.length > 0);
  return b;
}

/** Up to `active`: the socket opens, ready and probe_result arrive, media flows. */
export async function toActive(h: Harness) {
  const b = await toSocket(h);
  h.sock().open();
  h.sock().receive(READY);
  h.sock().receive(PROBE_RESULT);
  await until(() => h.session.state === "active");
  return b;
}

/** The server sends `m`. */
export const serve = (h: Harness, m: ServerMsg | Record<string, unknown>) =>
  h.sock().receive(m);

export function teardown(): void {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

export type { ZakadiSession };
