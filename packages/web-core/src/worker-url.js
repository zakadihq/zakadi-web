/* global Worker, URL */
// spec/06-web-sdk.md 6.1.4: copied to dist/ verbatim, never bundled by this package, so
// that the host's bundler sees `new URL()` directly inside `new Worker()` with static
// options and emits the engine worker and the capture worklet next to its own output.
export function createEngineWorker() {
  return new Worker(new URL("./engine.worker.js", import.meta.url), {
    type: "module",
    name: "zakadi-engine",
  });
}

export function captureWorkletUrl() {
  return new URL("./capture.worklet.js", import.meta.url).href;
}
