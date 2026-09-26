// A renderer bridge as @zakadi/web-core's session hands it to `<zakadi-call>`
// (spec/06-web-sdk.md 6.4), driven by the tests: the view, `ui` states, tiles and says
// are pushed by hand, and every call the element makes is a spy.
import { TERMINAL_STATES, type TerminalState } from "@zakadi/protocol";
import type {
  RendererBridge,
  RendererView,
  UiState,
  ZakadiRenderer,
  ZakadiSession,
} from "@zakadi/web-core";
import { vi } from "vitest";
import { defineZakadiCall } from "../src/index";

export type SayMsg = Parameters<Parameters<RendererBridge["onSay"]>[0]>[0];
export type Hsl = [number, number, number];

/** The SDK's English strings, as @zakadi/web-core resolves them for `en-NG`. */
export const STRINGS: RendererView["strings"] = {
  badge: "Automated check, no one is watching live",
  consent: {
    start: "Start",
    decline: "No thanks",
    listen: "Listen",
    language: "Language",
    brightness: "Turn your screen brightness up.",
    accessibility: "Accessibility options",
    screenReader: "Guide me by voice",
    extendedTime: "Give me more time",
  },
  permission: {
    title: "Allow your camera and microphone",
    body: "When your browser asks, choose Allow.",
  },
  connecting: "Calling...",
  unsupported: {
    title: "This browser can't run the check",
    body: "Open this page in an up-to-date version of Chrome, Firefox or Safari.",
  },
  controls: { repeat: "Repeat", more_time: "More time", cancel: "Cancel" },
  actions: { redial: "Call again", close: "Close" },
  end: {
    completed: "All done. Thank you.",
    incomplete: "We need one more step. Please try again.",
    disconnected: "The call dropped.",
    network_floor: "Your network is too slow right now.",
    cancelled: "The check was cancelled.",
    error: "Something went wrong. Please try again.",
    unsupported_device: "Sorry, this device can't run the check.",
    permission_denied: "This check needs your camera and microphone.",
    interrupted: "The call was interrupted.",
    sdk_disabled: "This check is not available right now.",
  },
};

export const TERMINALS = Object.keys(TERMINAL_STATES) as TerminalState[];

/** The view of a screen, with `redial` as the session derives it (5.8). */
export function viewOf(
  screen: RendererView["screen"],
  more: Partial<RendererView> = {},
): RendererView {
  return {
    screen,
    lang: "en-NG",
    languages: ["en-NG"],
    consentCopy: {
      title: "A short video check",
      body: "Follow two prompts on camera.",
      recording_notice: "Two still frames are kept for 7 days.",
    },
    brand: { primary: "#0A5", logo_url: null },
    theme: {},
    strings: STRINGS,
    a11y: {
      screen_reader: false,
      captions: true,
      reduced_motion: false,
      extended_time: false,
    },
    character: null,
    lottieRenderer: "auto",
    localMeter: false,
    message: null,
    inApp: null,
    previewHidden: false,
    redial:
      screen in TERMINAL_STATES &&
      TERMINAL_STATES[screen as TerminalState].offersRedial,
    ...more,
  };
}

/** A `ui` state with every field, as the transcripts carry them (1.5). */
export function uiState(more: Partial<UiState> = {}): UiState {
  return {
    phase: "framing",
    self_view: { oval: true, oval_emphasis: "normal", fill: "none" },
    arc: { visible: false, direction: "user_left", progress: 0 },
    character: { anim: "wave" },
    caption: { text: "Hi.", pictogram: "wave" },
    digits: { visible: false, values: [] },
    surround: { brightness: 0.9, flood: false },
    badge: "automated",
    progress: { step: 0, of: 2 },
    controls: { repeat: true, more_time: true, cancel: true },
    ...more,
  };
}

export interface Fake {
  bridge: RendererBridge;
  session: { state: string };
  stream: MediaStream;
  /** The playback bus of 6.2.9, null until audio is unlocked. */
  analyser: { getByteTimeDomainData: ReturnType<typeof vi.fn> } | null;
  view: RendererView;
  show(v: RendererView): void;
  ui(s: UiState): void;
  tile(symbol: number, hsl: Hsl): void;
  say(caption?: string): void;
  spies: {
    submitConsent: ReturnType<typeof vi.fn>;
    press: ReturnType<typeof vi.fn>;
    selectLanguage: ReturnType<typeof vi.fn>;
    setScreenReader: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
    redial: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    previewStream: ReturnType<typeof vi.fn>;
  };
}

export function fakeBridge(view: RendererView = viewOf("consent")): Fake {
  const subs = {
    view: new Set<(v: RendererView) => void>(),
    ui: new Set<(s: UiState) => void>(),
    tile: new Set<
      (m: { t: "tile"; symbol: number; min_ms: number }, c: Hsl) => void
    >(),
    say: new Set<(m: SayMsg) => void>(),
    feedback: new Set<(m: never) => void>(),
  };
  const sub =
    <F>(set: Set<F>) =>
    (h: F) => {
      set.add(h);
      return () => void set.delete(h);
    };
  const stream = new MediaStream();
  const spies = {
    submitConsent: vi.fn(),
    press: vi.fn(),
    selectLanguage: vi.fn(),
    setScreenReader: vi.fn(),
    listen: vi.fn(),
    redial: vi.fn(),
    close: vi.fn(),
    previewStream: vi.fn(() => stream),
  };
  let says = 0;
  const fake: Fake = {
    session: { state: "idle" },
    stream,
    analyser: null,
    view,
    spies,
    bridge: {
      get session() {
        return fake.session as unknown as ZakadiSession;
      },
      submitConsent: spies.submitConsent,
      previewStream: spies.previewStream,
      onUi: sub(subs.ui),
      onTile: sub(subs.tile) as RendererBridge["onTile"],
      onSay: sub(subs.say),
      onFeedback: sub(subs.feedback) as RendererBridge["onFeedback"],
      press: spies.press,
      view: () => fake.view,
      onView: sub(subs.view),
      selectLanguage: spies.selectLanguage,
      setScreenReader: spies.setScreenReader,
      listen: spies.listen,
      analyser: () => fake.analyser as unknown as AnalyserNode | null,
      redial: spies.redial,
      close: spies.close,
    },
    show(v) {
      fake.view = v;
      for (const h of subs.view) h(v);
    },
    ui(s) {
      for (const h of subs.ui) h(s);
    },
    tile(symbol, c) {
      for (const h of subs.tile) h({ t: "tile", symbol, min_ms: 400 }, c);
    },
    say(caption) {
      const m: SayMsg = {
        t: "say",
        id: `s${++says}`,
        cue: "greet.short",
        ...(caption === undefined ? {} : { caption }),
      };
      for (const h of subs.say) h(m);
    },
  };
  return fake;
}

export type Call = HTMLElement & ZakadiRenderer;

/** A defined `<zakadi-call>` in the page. */
export function mount(): Call {
  defineZakadiCall();
  const el = document.createElement("zakadi-call") as Call;
  document.body.append(el);
  return el;
}

/** An element bound to a fake bridge showing `view`. */
export function bound(view?: RendererView) {
  const el = mount();
  const fake = fakeBridge(view);
  el.bindSession(fake.bridge);
  return { el, fake, $: query(el), $$: queryAll(el) };
}

export const query =
  (el: HTMLElement) =>
  <T extends Element = HTMLElement>(sel: string): T =>
    el.shadowRoot!.querySelector<T>(sel)! as T;

export const queryAll =
  (el: HTMLElement) =>
  <T extends Element = HTMLElement>(sel: string): T[] => [
    ...el.shadowRoot!.querySelectorAll<T>(sel),
  ];

/** Whether `e` is shown: neither it nor an ancestor carries `hidden`. */
export const visible = (e: Element | null): boolean =>
  !!e && !e.closest("[hidden]");

/** The declarations of the stylesheet rule whose selector is `selector`. */
export function rule(css: string, selector: string): Record<string, string> {
  const at = css.indexOf("\n" + selector + "{");
  if (at < 0) throw new Error("no rule " + selector);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return Object.fromEntries(
    body
      .split(";")
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(":");
        return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
      }),
  );
}

/** A Node built-in, typed by the caller: the workspace's types leave out @types/node. */
export const builtin = <T>(id: string): T =>
  (
    globalThis as unknown as {
      process: { getBuiltinModule(id: string): T };
    }
  ).process.getBuiltinModule(id);

const { fileURLToPath } = builtin<{ fileURLToPath(url: string): string }>(
  "node:url",
);
/** The package's directory, `packages/ui/`, from this file's own URL. */
export const PKG = fileURLToPath(import.meta.url).replace(
  /test\/fakes\.ts$/,
  "",
);
/** The repository's root. */
export const REPO = PKG.replace(/packages\/ui\/$/, "");
