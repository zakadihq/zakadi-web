// @zakadi/web-core: the public API of spec/06-web-sdk.md 6.2.2 over spec/05-sdk-contract.md
// 5.2 and 5.11, and the renderer bridge `<zakadi-call>` of @zakadi/ui binds to (6.4).
// No module touches window, document, navigator or customElements when imported (6.5).
export { ZakadiError } from "./session/errors";
export { createZakadiSession, LIVENESS_EVENT_TYPES } from "./session/session";
export type {
  RendererBridge,
  RendererView,
  Screen,
  ZakadiRenderer,
} from "./session/bridge";
export type {
  A11yConfig,
  ConsentCopy,
  ConsentRecord,
  HeadlessBridge,
  IngestCandidate,
  Profile,
  PromptPackRef,
  SessionParams,
  SessionState,
  SessionUi,
  TelemetryEvent,
  ThemeTokens,
  UiOptions,
  UiState,
  ZakadiConfig,
  ZakadiErrorCode,
  ZakadiEvent,
  ZakadiEventMap,
  ZakadiOptions,
  ZakadiSession,
} from "./session/types";
