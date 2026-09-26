// The renderer bridge for `<zakadi-call>` of @zakadi/ui (spec/06-web-sdk.md 6.4): the
// headless bridge's streams plus what the local screens of 6.4.6 show. The session
// hands it to the element it mounts or is attached, and the element renders from it.
import type { TerminalState } from "@zakadi/protocol";
import type { A11y } from "../a11y/index";
import type { SdkStrings } from "../i18n/index";
import type {
  ConsentCopy,
  HeadlessBridge,
  SessionUi,
  ThemeTokens,
  UiOptions,
  ZakadiSession,
} from "./types";

/** A screen of the default UI: the local screens, the call, a terminal state (6.4.6). */
export type Screen =
  "idle" | "consent" | "permission" | "connecting" | "call" | TerminalState;

/** What the default UI shows, resolved from `sessionUi` and the host's options (5.2). */
export interface RendererView {
  screen: Screen;
  /** The language of the consent copy, the SDK strings and the prompt pack. */
  lang: string;
  /** The consent screen's language switcher: one entry per pack offered. */
  languages: string[];
  consentCopy: ConsentCopy | null;
  brand: NonNullable<SessionUi["brand"]>;
  theme: Partial<ThemeTokens>;
  strings: Readonly<SdkStrings>;
  a11y: A11y;
  /** The pack character's Lottie JSON, hash checked; null draws colour only (D73). */
  character: unknown;
  /**
   * The pack manifest's `tile_palette`, `[h, s, l]` per `tile` symbol; empty until the
   * pack loads, and read as empty where absent. Before the first `tile` the tile is a
   * neutral grey at its luminance (6.2.9, 6.4.3, G4).
   */
  palette?: [number, number, number][];
  lottieRenderer: NonNullable<UiOptions["lottieRenderer"]>;
  localMeter: boolean;
  /** The server's `message` for `sdk_disabled`. */
  message: string | null;
  /** 6.3: `banner` before consent (Facebook, Instagram on Android); `webview` on a denial. */
  inApp: "banner" | "webview" | null;
  /** The preview stays hidden while the camera probe runs (6.4.6). */
  previewHidden: boolean;
  /** The terminal state offers `redial` besides `close` (5.8). */
  redial: boolean;
}

export interface RendererBridge extends HeadlessBridge {
  readonly session: ZakadiSession;
  view(): RendererView;
  /** Called with the new view on every change. */
  onView(h: (v: RendererView) => void): () => void;
  /** The consent screen's switcher: loads that language's pack (6.2.9). */
  selectLanguage(lang: string): void;
  /** The consent screen's screen-reader option (6.2.10). */
  setScreenReader(on: boolean): void;
  /** "Listen": plays `consent.recording_notice` (6.4.6). */
  listen(): void;
  /** The playback bus for the listening ring, once audio is unlocked (6.2.9). */
  analyser(): AnalyserNode | null;
  /** The terminal actions (5.8): `redial_requested`; or release and `closed`. */
  redial(): void;
  close(): void;
}

/** What `<zakadi-call>` implements for attach() and start() (Z-048). */
export interface ZakadiRenderer extends HTMLElement {
  bindSession(bridge: RendererBridge): void;
  /** Unbinds when `bridge` is the one bound. */
  unbindSession(bridge: RendererBridge): void;
}
