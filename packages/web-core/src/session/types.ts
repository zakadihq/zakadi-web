// The public types of spec/06-web-sdk.md 6.2.2, over spec/05-sdk-contract.md 5.2 and
// 5.11, which hold where they differ. Optional fields also take `undefined`, so that
// hosts compiling with exactOptionalPropertyTypes can pass one through.
import type {
  ErrorCode,
  FeedbackMsg,
  SayMsg,
  SessionState as State,
  TileMsg,
  UiMsg,
} from "@zakadi/protocol";
import type { A11yConfig } from "../a11y/index";
import type { PromptPackRef } from "../audio/pack";
import type { Profile } from "../engine/messages";
import type { TelemetryEvent } from "../telemetry/index";
import type { IngestCandidate } from "../transport/rank";

export type { A11yConfig, IngestCandidate, Profile, PromptPackRef };
export type { TelemetryEvent };

export type SessionState = State;
export type ZakadiErrorCode = ErrorCode;
/** The `state` of a server `ui` message (01 1.5). */
export type UiState = UiMsg["state"];

/** The theme custom properties of the default UI (6.4.1), `--lv-*`. */
export interface ThemeTokens {
  /** --lv-color-primary, by default `sessionUi.brand.primary`. */
  colorPrimary: string;
  colorOnPrimary: string;
  colorText: string;
  captionBg: string;
  fontFamily: string;
  radius: string;
}

/** Consent copy in one language (02 2.2). */
export interface ConsentCopy {
  title: string;
  body: string;
  recording_notice?: string | undefined;
}

/** `ui` from POST /v1/sessions (02 2.2), passed through unchanged (D11). */
export interface SessionUi {
  consent_copy: Record<string, ConsentCopy>;
  brand?:
    | { primary?: string | undefined; logo_url?: string | null | undefined }
    | undefined;
  badge_text?: string | null | undefined;
  /** The languages the consent screen's switcher offers. */
  packs?: PromptPackRef[] | undefined;
}

/** What POST /v1/sessions returns for the SDK, each part unchanged (02 2.2). */
export interface SessionParams {
  clientToken: string;
  ingest: IngestCandidate[];
  promptPack: PromptPackRef;
  sessionUi: SessionUi;
}

/** Consent, carried over to a redial within 10 minutes in the same language (5.2). */
export interface ConsentRecord {
  /** The wall-clock time of the consent, sent as `hello.consent.at_ms_wall`. */
  atMsWall: number;
  lang: string;
  extendedTime: boolean;
}

/**
 * `UiOptions` of 5.2. `consentCopy`, `alternatePacks` and `brand` are host overrides
 * applied on `sessionUi` field by field (D40).
 */
export interface UiOptions {
  mode?: "default" | "headless" | undefined;
  /** Where start() mounts `<zakadi-call>` when none is attached; else the body. */
  container?: HTMLElement | undefined;
  theme?: Partial<ThemeTokens> | undefined;
  consentCopy?: SessionUi["consent_copy"] | undefined;
  alternatePacks?: PromptPackRef[] | undefined;
  brand?: SessionUi["brand"] | undefined;
  character?: boolean | undefined;
  lottieRenderer?: "auto" | "svg" | "canvas" | undefined;
  localMeter?: boolean | undefined;
  /** Fullscreen and the portrait lock on the consent tap (6.8); default on, off headless. */
  fullscreen?: boolean | undefined;
}

export interface ZakadiConfig extends SessionParams {
  locale: string;
  ui?: UiOptions | undefined;
  accessibility?: A11yConfig | undefined;
  telemetrySink?: ((e: TelemetryEvent) => void) | undefined;
  /** Default `<apiBase>/v1/telemetry`; false posts nothing. */
  telemetryEndpoint?: string | false | undefined;
  /** GET /v1/sdk/config and telemetry; default https://api.zakadi.dev. */
  apiBase?: string | undefined;
  /** A same-origin self-hosted engine.worker.js and capture worklet (6.1.4). */
  workerUrl?: string | undefined;
  assetBase?: string | undefined;
  /** A redial within 10 minutes in the same language: no consent screen (5.2). */
  priorConsent?: ConsentRecord | undefined;
  /** Set by @zakadi/react and @zakadi/angular; `hello.sdk.wrapper` (D25). */
  wrapper?: { name: string; version: string } | undefined;
}

/** What wrappers take up front. */
export type ZakadiOptions = Omit<ZakadiConfig, keyof SessionParams>;

/** No payload. */
export type NoFields = Record<string, never>;

export interface ZakadiEventMap {
  state_changed: { from: SessionState; to: SessionState };
  consent_given: { record: ConsentRecord };
  active: NoFields;
  redial_requested: NoFields;
  /** Once, after `ended` or `error`, when everything is released (5.11). */
  closed: NoFields;
  /** Booleans (5.11, D52). */
  permission: { camera: boolean; microphone: boolean };
  connected: { region: string; rtt_ms: number | null };
  /** The server's `ui.state.phase`; the value set is open (5.11). */
  phase: {
    phase:
      | "connecting"
      | "framing"
      | "action"
      | "listening"
      | "holding"
      | "done"
      | "error"
      | (string & Record<never, never>);
  };
  /** Only from a server `end`. */
  ended: { outcome: "completed" | "aborted"; reason: string };
  error: {
    code: ZakadiErrorCode;
    message: string;
    recoverable: boolean;
    retry_after_s?: number;
  };
  disconnected: { close_code: number };
}

export type ZakadiEvent = {
  [K in keyof ZakadiEventMap]: { type: K } & ZakadiEventMap[K];
}[keyof ZakadiEventMap];

/** The host carries every 5.8 obligation in headless mode (6.4.5). */
export interface HeadlessBridge {
  /** Synchronously in the host's click handler: it unlocks audio (6.2.9). */
  submitConsent(accepted: boolean, lang: string, extendedTime: boolean): void;
  /** The camera stream once permission is granted; the host mirrors it with CSS. */
  previewStream(): MediaStream | null;
  onUi(h: (s: UiState) => void): () => void;
  /** Paint within one frame; `hsl` is the pack's palette entry for `symbol`. */
  onTile(h: (m: TileMsg, hsl: [number, number, number]) => void): () => void;
  /** Captions; the SDK still plays the audio and sends `audio_state`. */
  onSay(h: (m: SayMsg) => void): () => void;
  onFeedback(h: (m: FeedbackMsg) => void): () => void;
  press(control: "repeat" | "more_time" | "cancel"): void;
}

export interface ZakadiSession {
  readonly state: SessionState;
  readonly profile: Profile | null;
  /** Hand it to the next session for a redial. */
  readonly consentRecord: ConsentRecord | null;
  /** Resolves on `active`; rejects with a ZakadiError, `cancelled` after cancel(). */
  start(): Promise<void>;
  /** Idempotent. */
  cancel(reason?: string): void;
  on<K extends keyof ZakadiEventMap>(
    type: K,
    h: (e: ZakadiEventMap[K]) => void,
  ): () => void;
  /** The renderer; start() mounts a `<zakadi-call>` into `ui.container` if none. */
  attach(el: HTMLElement): void;
  readonly headless: HeadlessBridge | null;
  /** Releases camera, microphone, engine and AudioContext; terminal. */
  dispose(): void;
}
