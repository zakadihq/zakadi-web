// encode (spec/06-web-sdk.md 6.2.4, 6.2.5, 6.2.7): the engine's encoders on the session media
// clock, the candidate list detection checks, and the recorder helpers of the main thread.
export {
  CANDIDATES,
  audioConfig,
  check,
  order,
  videoConfig,
} from "./candidates.js";
export type { Candidate, Checked, Rung } from "./candidates.js";
export { captureTimestamp } from "./frame.js";
export { createEncoder } from "./pipeline.js";
export type { EncoderOptions } from "./pipeline.js";
export { TIMESLICE, createRecorder, recordAudio } from "./recorder.js";
export type { RecorderOptions } from "./recorder.js";
export type {
  AudioSource,
  Chunk,
  EncodeEvent,
  EncodeStats,
  Pipeline,
  VideoSource,
} from "./types.js";

/** The processor `static/capture.worklet.js` registers. */
export const WORKLET_PROCESSOR = "zakadi-capture";
