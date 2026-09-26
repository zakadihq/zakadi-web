// The audio module (spec/06-web-sdk.md 6.2.1, 6.2.9): the prompt pack, its hash
// checks and cache, the unlock, `say` playback with its `audio_state` timing, and the
// AnalyserNode on the playback bus.
export { createAudio, type Audio, type AudioOptions } from "./player.js";
export {
  PackUnavailableError,
  type CueEntry,
  type LoadedPack,
  type Manifest,
  type PackFile,
  type PromptPackRef,
} from "./pack.js";
