// The session (spec/06-web-sdk.md 6.2.2, 6.2.10, 6.8, 6.10; spec/05-sdk-contract.md 5.2,
// 5.8, 5.11, 5.14, 5.15): the client state machine on the main thread. It runs the
// start() sequence over detect, capture, probe and audio, hosts the engine, validates
// the server's messages and hands them, in order, to the headless and renderer bridges.
import {
  TERMINAL_STATES,
  terminalStateForEnd,
  validateActionMsg,
  validateEndMsg,
  validateErrorMsg,
  validateFeedbackMsg,
  validateProbeResultMsg,
  validateReadyMsg,
  validateSayMsg,
  validateTileMsg,
  validateUiMsg,
  type ByeMsg,
  type EndMsg,
  type ErrorCode,
  type FeedbackMsg,
  type HelloMsg,
  type SayMsg,
  type TerminalState,
  type TileMsg,
  type UiEventMsg,
} from "@zakadi/protocol";
import { a11ySettings, haptic } from "../a11y/index";
import type { LoadedPack, PromptPackRef } from "../audio/pack";
import { createAudio } from "../audio/player";
import {
  applyExposure,
  attachPreview,
  closeCamera,
  openCamera,
  type Camera,
} from "../capture/camera";
import { cameraMeta } from "../capture/meta";
import { audioSource, pumpFrames, sendVideo } from "../capture/sources";
import { deviceFacts, inAppBrowser, matchQuirks } from "../detect/device";
import {
  detect,
  videoSourceKind,
  type AudioPath,
  type Failure,
} from "../detect/profile";
import { check, order, videoConfig } from "../encode/candidates";
import { recordAudio } from "../encode/recorder";
import { pickHost, type EngineHost, type HostOptions } from "../engine/host";
import type { FromEngine, InitMsg, Profile } from "../engine/messages";
import { sdkStrings } from "../i18n/index";
import { cameraProbe } from "../probe/probe";
import {
  createTelemetry,
  type Fields,
  type Telemetry,
  type TelemetryName,
} from "../telemetry/index";
import type { SessionMsg } from "../transport/client";
import { rankIngest, type RankedCandidate } from "../transport/rank";
import { captureWorkletUrl } from "../worker-url.js";
import type {
  RendererBridge,
  RendererView,
  Screen,
  ZakadiRenderer,
} from "./bridge";
import { refusal, sdkConfig } from "./config";
import {
  closeError,
  endError,
  recoverable,
  screenFor,
  ZakadiError,
} from "./errors";
import { helloCaps } from "./hello";
import { watch } from "./lifecycle";
import { readToken } from "./token";
import type {
  ConsentRecord,
  SessionState,
  UiState,
  ZakadiConfig,
  ZakadiEventMap,
  ZakadiSession,
} from "./types";

declare const __LV_VERSION__: string;

/** Every event type (5.11), for wrappers that forward them all. */
export const LIVENESS_EVENT_TYPES: readonly (keyof ZakadiEventMap)[] = [
  "state_changed",
  "consent_given",
  "active",
  "redial_requested",
  "closed",
  "permission",
  "connected",
  "phase",
  "ended",
  "error",
  "disconnected",
];

/** What the session takes from outside: its engine host (6.1.4). */
export interface SessionDeps {
  host(o: HostOptions): Promise<EngineHost>;
}

// Rung 0 of the 01 1.5 ladder: detection checks the candidates at its size (6.3).
const HINT = {
  rung: 0,
  w: 480,
  h: 640,
  fps: 20,
  video_kbps: 900,
  audio_kbps: 24,
};
const API = "https://api.zakadi.dev";
const CONSENT_MS = 600000;
const CLOSE_MS = 30000;
const STOP_MS = 1000;
const CLOCK_MS = 1000;
const CANCEL_MS = 5000; // [estimate]

// The server messages the engine forwards, each validated before a bridge sees it.
const VALID: Record<string, (m: unknown) => boolean> = {
  ready: validateReadyMsg,
  probe_result: validateProbeResultMsg,
  ui: validateUiMsg,
  say: validateSayMsg,
  action: validateActionMsg,
  tile: validateTileMsg,
  feedback: validateFeedbackMsg,
  end: validateEndMsg,
  error: validateErrorMsg,
};

// The `ui_event` of each call control (6.4.2).
const CONTROLS = {
  repeat: "repeat_requested",
  more_time: "more_time_requested",
  cancel: "cancel_pressed",
} as const;

const RECORDER: Partial<Record<AudioPath, string>> = {
  "recorder-opus": "audio/webm;codecs=opus",
  "recorder-aac": "audio/mp4",
};

interface Consent {
  accepted: boolean;
  lang: string;
  extendedTime: boolean;
}

function checkConfig(c: ZakadiConfig): void {
  const bad = (what: string) => {
    throw new TypeError("createZakadiSession: " + what);
  };
  if (!c || typeof c !== "object") bad("a config object is required");
  if (typeof c.clientToken !== "string" || !c.clientToken)
    bad("clientToken is required");
  if (!Array.isArray(c.ingest) || !c.ingest.length)
    bad("ingest lists no candidate");
  if (typeof c.promptPack?.url !== "string") bad("promptPack is required");
  if (!c.sessionUi || typeof c.sessionUi !== "object")
    bad("sessionUi is required");
  if (typeof c.locale !== "string") bad("locale is required");
}

/** createZakadiSession with its engine host given. */
export function createSession(
  options: ZakadiConfig,
  deps: SessionDeps = { host: pickHost },
): ZakadiSession {
  checkConfig(options);
  // The token lives in this one variable, not in a config the session keeps, until
  // it is sent once, in `hello` (6.9, 5.13).
  const { clientToken, ...config } = options;
  let token = clientToken;
  const claims = readToken(token);
  const ui = config.ui ?? {};
  const headless = ui.mode === "headless";
  const apiBase = config.apiBase ?? API;
  const packs: PromptPackRef[] = [];
  for (const p of [
    config.promptPack,
    ...(ui.alternatePacks ?? config.sessionUi.packs ?? []),
  ])
    if (!packs.some((q) => q.lang === p.lang)) packs.push(p);
  const packFor = (l: string): PromptPackRef | undefined =>
    packs.find((p) => p.lang === l) ??
    packs.find((p) => p.lang.split("-")[0] === l.split("-")[0]);
  // Host overrides on sessionUi, field by field (5.2, D40).
  const copies = { ...config.sessionUi.consent_copy };
  for (const [l, copy] of Object.entries(ui.consentCopy ?? {}))
    copies[l] = { ...copies[l], ...copy };
  const brand = { ...config.sessionUi.brand, ...ui.brand };

  const handlers = new Map<string, Set<(e: never) => void>>();
  const subs = {
    ui: new Set<(s: UiState) => void>(),
    tile: new Set<(m: TileMsg, hsl: [number, number, number]) => void>(),
    say: new Set<(m: SayMsg) => void>(),
    feedback: new Set<(m: FeedbackMsg) => void>(),
    view: new Set<(v: RendererView) => void>(),
  };

  let state: SessionState = "idle";
  let shown: Screen = "idle";
  let profile: Profile | null = null;
  let record: ConsentRecord | null = null;
  let consent: Consent | undefined;
  let waiting: ((c: Consent) => void) | undefined;
  let prior: ConsentRecord | undefined;
  let lang = config.promptPack.lang;
  let packRef = config.promptPack;
  let pack: Promise<LoadedPack> | undefined;
  let screenReader = config.accessibility?.screenReader;
  let started = false;
  let disposed = false;
  let consented = false;
  let finished = false; // `ended` or `error` emitted
  let released = false;
  let active = false;
  let opened = false;
  let closedSocket = false;
  let byeSent = false;
  let endSeen = false;
  let cancelling = false;
  let message: string | null = null;
  let inApp: "banner" | "webview" | null = null;
  let previewHidden = false;
  let character: unknown = null;
  let palette: [number, number, number][] = [];
  let phase = "";
  let region = "";
  let serverDetail = ""; // of the server's last `error`
  let ranked: RankedCandidate[] = [];
  let t0: number | null = null; // the media clock's origin on this thread's clock
  let startedAt = 0;
  let telemetry: Telemetry | undefined;
  let camera: Camera | undefined;
  let hosting: Promise<EngineHost> | undefined;
  let host: EngineHost | undefined;
  let element: ZakadiRenderer | undefined;
  let bound: ZakadiRenderer | undefined;
  let mounted = false;
  let lock: { release(): Promise<void> } | undefined;
  let fullscreen = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let afterClose: (() => void) | undefined;
  let settle: [() => void, (e: ZakadiError) => void] | undefined;
  const stops: (() => void)[] = [];

  const emit = <K extends keyof ZakadiEventMap>(
    type: K,
    e: ZakadiEventMap[K],
  ) => {
    for (const h of handlers.get(type) ?? []) {
      try {
        (h as (e: ZakadiEventMap[K]) => void)(e);
      } catch {
        // A host's handler never stops the session.
      }
    }
  };
  const fire = <A extends unknown[]>(set: Set<(...a: A) => void>, ...a: A) => {
    for (const h of set) {
      try {
        h(...a);
      } catch {
        // Nor does a renderer's.
      }
    }
  };
  const sub = <F>(set: Set<F>, h: F) => {
    set.add(h);
    return () => void set.delete(h);
  };
  const tel = (name: TelemetryName, fields: Fields = {}) =>
    telemetry?.emit(name, fields);

  const a11y = () => ({
    ...a11ySettings({
      ...config.accessibility,
      ...(screenReader === undefined ? {} : { screenReader }),
    }),
    // The consent screen's option, or the host's: either doubles the deadlines (5.10).
    extended_time:
      !!(record ?? consent)?.extendedTime ||
      !!config.accessibility?.extendedTime,
  });
  const view = (): RendererView => ({
    screen: shown,
    lang,
    languages: packs.map((p) => p.lang),
    consentCopy:
      copies[lang] ?? copies[config.locale] ?? Object.values(copies)[0] ?? null,
    brand,
    theme: ui.theme ?? {},
    strings: sdkStrings(lang, config.sessionUi.badge_text),
    a11y: a11y(),
    character: ui.character === false ? null : character,
    palette,
    lottieRenderer: ui.lottieRenderer ?? "auto",
    localMeter: !!ui.localMeter,
    message,
    inApp,
    previewHidden,
    redial:
      shown in TERMINAL_STATES &&
      TERMINAL_STATES[shown as TerminalState].offersRedial,
  });
  const changed = () => fire(subs.view, view());
  const show = (s: Screen) => {
    shown = s;
    changed();
  };
  const setState = (to: SessionState) => {
    const from = state;
    state = to;
    if (from !== to) emit("state_changed", { from, to });
  };

  // The session media clock (1.3.3): 0 before its first frame.
  const mediaMs = (perfMs: number) => (t0 === null ? 0 : perfMs - t0);
  const audio = createAudio({
    send: (msg) => host?.post({ k: "client", msg }),
    mediaMs,
    emit: tel,
  });
  const uiEvent = (event: UiEventMsg["event"], detail = {}) => {
    if (opened && !closedSocket)
      host!.post({
        k: "client",
        msg: {
          t: "ui_event",
          event,
          detail,
          at_ms: Math.max(0, Math.floor(mediaMs(performance.now()))),
        },
      });
  };
  // One bye, which the engine sends after the final attest while the socket is open;
  // with `close`, it closes the socket right after (6.10).
  const bye = (msg: ByeMsg, close = false) => {
    if (!host || !opened || closedSocket || byeSent || endSeen) return;
    byeSent = true;
    host.post(close ? { k: "stop", bye: msg } : { k: "client", msg });
  };

  const stopCapture = () => {
    stops.splice(0).forEach((stop) => stop());
    if (camera) closeCamera(camera);
    void lock?.release().catch(() => undefined);
    lock = undefined;
  };

  // The call is over: capture stops, a socket still being dialled is dropped, the state
  // is terminal. The terminal screen stays until the host dismisses it or 30 s pass.
  const finish = (to: "ended" | "error", screen: Screen | null) => {
    finished = true;
    stopCapture();
    if (host && !opened) host.post({ k: "stop" });
    if (screen) shown = screen;
    setState(to);
  };
  const terminal = (err?: ZakadiError) => {
    if (err) settle?.[1](err);
    settle = undefined;
    changed();
    // The local cue, unless a `say` arrived in the 3 s before (5.8).
    if (shown in TERMINAL_STATES) audio.terminal(shown as TerminalState);
    if (!released) closeTimer = setTimeout(release, CLOSE_MS);
  };

  /** A runtime failure (6.10); after open the client's own come after their bye. */
  const fail = (
    code: ErrorCode,
    cause: string,
    o: {
      bye?: ByeMsg;
      close?: boolean;
      retryAfterS?: number | undefined;
      screen?: Screen | null;
    } = {},
  ) => {
    if (finished) return;
    if (o.bye) bye(o.bye, o.close);
    const ok = recoverable(code, cause);
    if (code === "cancelled")
      tel("end", {
        outcome: "aborted",
        reason: "user_cancel",
        duration_ms: Math.round(performance.now() - startedAt),
      });
    else if (code !== "consent_declined") tel("error", { code });
    finish("error", o.screen === undefined ? screenFor(code) : o.screen);
    emit("error", {
      code,
      message: cause,
      recoverable: ok,
      ...(o.retryAfterS === undefined ? {} : { retry_after_s: o.retryAfterS }),
    });
    terminal(new ZakadiError(code, cause, ok, o.retryAfterS));
  };

  const onEnd = (m: EndMsg) => {
    endSeen = true;
    tel("end", {
      outcome: m.outcome,
      reason: m.reason,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    if (finished) return;
    finish("ended", terminalStateForEnd(m.reason));
    emit("ended", { outcome: m.outcome, reason: m.reason });
    const code = endError(m.reason);
    terminal(new ZakadiError(code, "end " + m.reason, recoverable(code, "")));
  };

  const onServer = (m: SessionMsg) => {
    // Unknown types are ignored and a message failing its schema is dropped (1.2);
    // after the terminal state only `end` still counts.
    if (!VALID[m.t]?.(m) || (finished && m.t !== "end")) return;
    switch (m.t) {
      case "ready": {
        const warm = ranked.find((c) => c.region === region)?.warmMs;
        emit("connected", {
          region,
          rtt_ms: warm === undefined ? null : Math.round(warm),
        });
        break;
      }
      case "probe_result":
        tel("probe", {
          goodput_kbps: m.goodput_kbps,
          rtt_ms: m.rtt_ms,
          start_rung: m.start_rung,
        });
        break;
      case "ui":
        if (m.state.phase !== phase) {
          phase = m.state.phase;
          emit("phase", { phase });
          tel("ui_state", { phase });
        }
        fire(subs.ui, m.state);
        break;
      case "say":
        audio.say(m);
        haptic(m.cue, a11y());
        fire(subs.say, m);
        break;
      case "tile": {
        const at = performance.now();
        fire(subs.tile, m, palette[m.symbol] ?? [0, 0, 50]);
        globalThis.requestAnimationFrame?.(() =>
          tel("tile_latency_ms", { ms: Math.round(performance.now() - at) }),
        );
        break;
      }
      case "feedback":
        fire(subs.feedback, m);
        break;
      case "end":
        onEnd(m);
        break;
      case "error":
        // It precedes the close that maps it (6.10); its detail carries retry_after
        // for 4008 should the close reason arrive empty (1.5).
        serverDetail = m.detail ?? "";
        break;
      // `action` has no bridge.
    }
  };

  const onEngine = (m: FromEngine) => {
    if (released) {
      if (m.k === "closed") afterClose?.();
      return;
    }
    switch (m.k) {
      case "open":
        opened = true;
        region = m.region;
        tel("connect", { region: m.region, ms: Math.round(m.ms) });
        break;
      case "media-clock":
        t0 = m.t0PerfMs;
        break;
      case "first-media":
        // `active`: the first media message after probe_result or its timeout (5.2).
        if (finished || active) break;
        active = true;
        setState("active");
        show("call");
        emit("active", {});
        settle?.[0]();
        settle = undefined;
        wake();
        break;
      case "server":
        onServer(m.msg);
        break;
      case "rung":
        tel("rung_change", { from: m.from, to: m.to, reason: m.reason });
        break;
      case "stats": {
        const fields: Fields = {};
        for (const [k, v] of Object.entries(m.s))
          if (k !== "t" && v !== undefined) fields[k] = v;
        tel("stats", fields);
        break;
      }
      case "telemetry":
        tel(m.name, m.fields);
        break;
      case "fatal":
        // The engine sent the matching bye itself.
        fail(m.code, m.code);
        break;
      case "closed": {
        closedSocket = true;
        emit("disconnected", { close_code: m.code });
        const [code, after] = closeError(m.code, m.reason || serverDetail);
        fail(
          cancelling && code === "network_unavailable" ? "cancelled" : code,
          "close " + m.code,
          { retryAfterS: after },
        );
        afterClose?.();
        break;
      }
    }
  };

  // The screen stays on while the call is active (6.8).
  const wake = () =>
    (
      navigator as Navigator & {
        wakeLock?: {
          request(t: "screen"): Promise<{ release(): Promise<void> }>;
        };
      }
    ).wakeLock
      ?.request("screen")
      .then(
        (l) => {
          if (active && !finished) lock = l;
          else void l.release().catch(() => undefined);
        },
        () => undefined,
      );

  // Android: fullscreen on the consent tap, then the portrait lock. Where either fails,
  // and always on iOS, the layout adapts and `orientation_unlocked` is reported (6.8).
  const orient = () => {
    const lockable = (
      globalThis.screen as { orientation?: { lock?(o: string): Promise<void> } }
    )?.orientation;
    const el =
      (ui.fullscreen ?? !headless) &&
      lockable?.lock &&
      (bound ?? ui.container ?? document.documentElement);
    if (!el || !el.requestFullscreen) return tel("orientation_unlocked");
    el.requestFullscreen()
      .then(() => {
        fullscreen = true;
        return lockable!.lock!("portrait");
      })
      .catch(() => tel("orientation_unlocked"));
  };

  const selectLanguage = (l: string) => {
    const p = packFor(l);
    if (!p || consented || finished) return;
    lang = p.lang;
    if (p !== packRef) {
      packRef = p;
      // Loaded the same way, and named in hello.prompt_pack (6.2.9).
      if (pack) load();
    }
    changed();
  };
  const load = () => {
    pack = audio.load(packRef);
    pack.catch(() => undefined);
  };

  const submitConsent = (
    accepted: boolean,
    l: string,
    extendedTime: boolean,
  ) => {
    if (
      typeof accepted !== "boolean" ||
      typeof l !== "string" ||
      typeof extendedTime !== "boolean"
    )
      throw new TypeError(
        "submitConsent(accepted: boolean, lang: string, extendedTime: boolean)",
      );
    if (disposed || consent || consented || finished) return;
    selectLanguage(l);
    consent = { accepted, lang, extendedTime };
    if (accepted) {
      // Inside the user's gesture (6.2.9, 6.8).
      audio.unlock();
      orient();
    }
    waiting?.(consent);
  };

  const release = () => {
    if (released) return;
    // Dismissed during the call: the user ends it.
    if (started && !finished)
      fail("cancelled", "close", {
        bye: { t: "bye", reason: "user_cancel", detail: "close" },
        close: true,
      });
    released = true;
    clearTimeout(closeTimer);
    stopCapture();
    const h = host;
    if (h && opened && !closedSocket) {
      h.post({ k: "stop" });
      const timer = setTimeout(() => h.terminate(), STOP_MS);
      afterClose = () => {
        clearTimeout(timer);
        h.terminate();
      };
    } else if (h) h.terminate();
    else
      void hosting?.then(
        (x) => x.terminate(),
        () => undefined,
      );
    audio.dispose();
    telemetry?.dispose();
    bound?.unbindSession?.(bridge);
    if (mounted) bound?.remove();
    bound = undefined;
    if (fullscreen) void document.exitFullscreen?.().catch(() => undefined);
    if (started) emit("closed", {});
  };

  const bind = (el: ZakadiRenderer) => {
    globalThis.customElements?.upgrade?.(el);
    if (typeof el.bindSession !== "function")
      throw new TypeError(
        "attach(): the element is not a <zakadi-call> of @zakadi/ui",
      );
    if (bound && bound !== el) bound.unbindSession(bridge);
    el.bindSession(bridge);
    bound = el;
  };

  // The engine's inputs from clones of the tracks, so that a transfer never detaches the
  // preview (6.2.3, 6.3); the rVFC frames and the worklet's clock pairs as they come.
  const feed = async (
    h: EngineHost,
    cam: Camera,
    det: Awaited<ReturnType<typeof detect>>,
    ctx: AudioContext | null,
    soft: boolean,
  ): Promise<AudioPath> => {
    let path: AudioPath = det.profile === "webcodecs" ? det.audio : "none";
    if (path === "webcodecs-worklet" && !ctx) path = "none";
    const worklet = config.assetBase
      ? new URL("capture.worklet.js", new URL(config.assetBase, location.href))
          .href
      : captureWorkletUrl();
    const input = await audioSource(cam, path, ctx!, worklet).catch(() => {
      path = "none";
      return {
        source: { kind: "none" as const },
        transfer: [],
        recorder: undefined,
      };
    });
    if (finished) return path;
    const init: InitMsg = {
      k: "init",
      profile: det.profile,
      video: { kind: "frames" },
      audio: input.source,
      origin: performance.timeOrigin,
      settings: cam.audio?.getSettings(),
      preferSoftware: soft,
    };
    if (det.profile === "mediarecorder")
      h.post({ ...init, recorder: { stream: cam.stream, mime: det.mime } });
    else if (
      sendVideo(cam, videoSourceKind(h.caps.mstp), (video, t) =>
        h.post({ ...init, video }, [...t, ...input.transfer]),
      ) === "frames"
    ) {
      const v = document.createElement("video");
      v.style.cssText = "position:fixed;top:0;width:1px;opacity:0";
      attachPreview(v, cam);
      document.body.append(v);
      void v.play().catch(() => undefined);
      stops.push(
        pumpFrames(v, (frame) => h.post({ k: "frame", frame }, [frame])),
        () => v.remove(),
      );
    }
    if (input.recorder)
      recordAudio(input.recorder.track, RECORDER[path]!, input.recorder.port);
    if (input.source.kind === "pcm" && ctx) {
      const pair = () => {
        const ts = ctx.getOutputTimestamp?.();
        if (ts?.performanceTime !== undefined && ts.contextTime !== undefined)
          h.post({
            k: "clock",
            perfMs: ts.performanceTime,
            ctxTime: ts.contextTime,
          });
      };
      pair();
      const timer = setInterval(pair, CLOCK_MS);
      stops.push(() => clearInterval(timer));
    }
    return path;
  };

  const run = async (): Promise<void> => {
    const facts = await deviceFacts();
    inApp = inAppBrowser() === "banner" ? "banner" : null;
    const sdk: HelloMsg["sdk"] = {
      platform: "web",
      name: "@zakadi/web-core",
      version: __LV_VERSION__,
      ...facts.sdk,
      ...(config.wrapper ? { wrapper: config.wrapper } : {}),
    };
    telemetry = createTelemetry({
      sessionId: claims.sub,
      sdk,
      sink: config.telemetrySink,
      endpoint:
        config.telemetryEndpoint ?? new URL("/v1/telemetry", apiBase).href,
    });
    const cfg = await sdkConfig(apiBase, __LV_VERSION__, config.wrapper, () =>
      tel("config_unavailable"),
    );
    if (finished) return;
    const refused = refusal(cfg, __LV_VERSION__, config.wrapper);
    if (refused) {
      message = cfg.message;
      return fail("sdk_disabled", refused);
    }

    // Detection before consent, so that an unsupported browser fails fast (6.3, 5.5).
    const caps = matchQuirks(cfg.device_quirks, facts);
    const soft = !!caps.prefer_software_encoder;
    const det = await detect(
      order(soft).map((c) => videoConfig(HINT, c)),
      caps,
    ).catch((e: Failure) => e);
    if (finished) return;
    if (det instanceof Error) return fail(det.code ?? "internal", det.message);
    profile = det.profile;
    hosting = deps.host({
      profile: det.profile,
      workerUrl: config.workerUrl,
      emit: tel,
    });
    hosting.catch(() => undefined);
    const checked =
      det.profile === "webcodecs" ? check([HINT], soft) : undefined;
    void checked?.then(({ diff }) => {
      if (diff.length) tel("encoder_unrecognised", { members: diff.join(",") });
    });

    // Consent, unless carried over from a redial (5.2).
    if (prior) record = prior;
    else {
      setState("consent");
      show("consent");
      tel("consent_shown");
      const c = consent ?? (await new Promise<Consent>((r) => (waiting = r)));
      tel("consent_result", { accepted: c.accepted });
      if (finished) return;
      if (!c.accepted) {
        fail("consent_declined", "declined", { screen: null });
        return release();
      }
      record = {
        atMsWall: Date.now(),
        lang: c.lang,
        extendedTime: c.extendedTime,
      };
    }
    consented = true;
    emit("consent_given", { record });

    setState("permission");
    show("permission");
    const cam = await openCamera(caps).catch((e: Failure) => e);
    if (cam instanceof Error) {
      emit("permission", { camera: false, microphone: false });
      tel("permission_result", { camera: false, microphone: false });
      if (cam.code === "permission_denied" && inAppBrowser()) inApp = "webview";
      return fail(cam.code, cam.message);
    }
    if (finished) return closeCamera(cam);
    camera = cam;
    emit("permission", { camera: true, microphone: !!cam.audio });
    tel("permission_result", { camera: true, microphone: !!cam.audio });

    setState("connecting");
    previewHidden = true;
    show("connecting");
    const ctx = (audio.analyser?.context ?? null) as AudioContext | null;
    stops.push(
      watch(cam, ctx, {
        event: uiEvent,
        interrupted: (cause) =>
          fail("interrupted", cause, {
            bye: { t: "bye", reason: "app_background", detail: cause },
          }),
        visible: () => {
          if (active && !finished && !lock) void wake();
        },
        pagehide: () => {
          fail("interrupted", "pagehide", {
            bye: { t: "bye", reason: "app_background", detail: "pagehide" },
            close: true,
          });
          release();
        },
        ended: (revoked) =>
          revoked
            ? fail("permission_denied", "permission_revoked", {
                bye: { t: "bye", reason: "permission_revoked" },
              })
            : fail("capture_error", "track_ended", {
                bye: { t: "bye", reason: "capture_error" },
              }),
        suspended: () => {
          const tap = () => audio.unlock();
          document.addEventListener("pointerdown", tap, { once: true });
          stops.push(() => document.removeEventListener("pointerdown", tap));
        },
      }),
    );

    // The camera probe and the region ranking in parallel, then the pack (6.2.10).
    const [probe, best] = await Promise.all([
      cameraProbe(cam.video, cam.constraints),
      rankIngest(config.ingest),
    ]);
    ranked = best;
    previewHidden = false;
    changed();
    if (finished) return;
    await applyExposure(cam);
    const loaded = await pack!.catch(() => null);
    if (finished) return;
    if (!loaded) return fail("pack_unavailable", "no_manifest");
    palette = loaded.manifest.tile_palette;
    character = loaded.character;
    changed();
    const h = await hosting;
    if (finished) return;
    host = h;
    h.listen(onEngine);
    const path = await feed(h, cam, det, ctx, soft);
    const meta = await cameraMeta(
      cam.video,
      probe,
      (await checked)?.encoder ?? { impl: "unknown", is_config_supported: {} },
      claims.jti,
    );
    if (finished) return;
    h.post({
      k: "connect",
      ranked,
      hello: {
        t: "hello",
        v: 1,
        token,
        sdk,
        caps: helloCaps(det, path, cam.video),
        prompt_pack: { lang: packRef.lang, version: packRef.version },
        a11y: a11y(),
        consent: {
          biometric: true,
          recording: true,
          at_ms_wall: record.atMsWall,
        },
      },
      cameraMeta: meta,
      jti: claims.jti,
      maxRung: caps.max_rung,
    });
    // Sent once, in hello; no reference to it stays here (6.9).
    token = "";
  };

  const bridge: RendererBridge = {
    get session() {
      return session;
    },
    submitConsent,
    previewStream: () => (camera && !finished ? camera.stream : null),
    onUi: (h) => sub(subs.ui, h),
    onTile: (h) => sub(subs.tile, h),
    onSay: (h) => sub(subs.say, h),
    onFeedback: (h) => sub(subs.feedback, h),
    press(control) {
      if (!Object.prototype.hasOwnProperty.call(CONTROLS, control))
        throw new TypeError("press(): unknown control " + String(control));
      const event = CONTROLS[control];
      uiEvent(event);
      // Cancel is followed by `bye user_cancel` (6.4.2).
      if (control === "cancel") session.cancel();
    },
    view,
    onView: (h) => sub(subs.view, h),
    selectLanguage,
    setScreenReader(on) {
      if (!consented) screenReader = on;
      changed();
    },
    listen: () => audio.notice(),
    analyser: () => audio.analyser,
    redial: () => emit("redial_requested", {}),
    close: release,
  };

  const session: ZakadiSession = {
    get state() {
      return state;
    },
    get profile() {
      return profile;
    },
    get consentRecord() {
      return record;
    },
    get headless() {
      return headless ? bridge : null;
    },
    start() {
      if (disposed)
        return Promise.reject(
          new TypeError("start(): the session is disposed"),
        );
      if (started)
        return Promise.reject(
          new TypeError("start(): a session starts once; create another"),
        );
      if (!headless) {
        try {
          if (!element) {
            if (!globalThis.customElements?.get("zakadi-call"))
              throw new TypeError(
                'start(): no <zakadi-call> is defined; import "@zakadi/ui/define" or call defineZakadiCall() of @zakadi/ui, or set ui.mode to "headless"',
              );
            element = document.createElement("zakadi-call") as ZakadiRenderer;
            (ui.container ?? document.body).append(element);
            mounted = true;
          }
          bind(element);
        } catch (e) {
          if (mounted) element?.remove();
          if (mounted) element = undefined;
          mounted = false;
          return Promise.reject(e);
        }
      }
      started = true;
      startedAt = performance.now();
      // A redial within 10 minutes, in a language this session offers (5.2): no consent
      // screen, and the tap that called start() is the gesture that unlocks audio.
      const p = config.priorConsent;
      const age = p ? Date.now() - p.atMsWall : -1;
      if (
        p &&
        age >= 0 &&
        age < CONSENT_MS &&
        packFor(p.lang)?.lang === p.lang
      ) {
        prior = p;
        selectLanguage(p.lang);
        audio.unlock();
      }
      // The pack fetch starts here, within its 5 s (6.2.9).
      load();
      const promise = new Promise<void>((res, rej) => (settle = [res, rej]));
      run().catch((e: unknown) => fail("internal", String(e)));
      return promise;
    },
    cancel(reason) {
      if (!started || finished || cancelling) return;
      const msg: ByeMsg = {
        t: "bye",
        reason: "user_cancel",
        ...(reason ? { detail: reason } : {}),
      };
      if (!active) return fail("cancelled", reason ?? "cancel", { bye: msg });
      // After `active` the server ends the call: `end`, then 4010 (6.10).
      cancelling = true;
      bye(msg);
      const timer = setTimeout(
        () => fail("cancelled", reason ?? "cancel"),
        CANCEL_MS,
      );
      stops.push(() => clearTimeout(timer));
    },
    on(type, h) {
      if (!LIVENESS_EVENT_TYPES.includes(type))
        throw new TypeError("on(): unknown event " + String(type));
      if (typeof h !== "function")
        throw new TypeError("on(): the handler is not a function");
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(h as (e: never) => void);
      return () => void set.delete(h as (e: never) => void);
    },
    attach(el) {
      if (disposed) throw new TypeError("attach(): the session is disposed");
      if (!el || typeof el !== "object")
        throw new TypeError("attach(): an element is required");
      // An element start() mounted gives way to the host's.
      if (mounted && element !== el) element?.remove();
      element = el as ZakadiRenderer;
      mounted = false;
      if (started && !released && !headless) bind(element);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (started)
        fail("cancelled", "dispose", {
          bye: { t: "bye", reason: "unknown", detail: "dispose" },
          close: true,
        });
      release();
    },
  };
  return session;
}

/** A session, without side effects until start() (6.2.2). */
export function createZakadiSession(config: ZakadiConfig): ZakadiSession {
  return createSession(config);
}
