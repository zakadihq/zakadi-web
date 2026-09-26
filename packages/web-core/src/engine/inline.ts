// The inline engine (spec/06-web-sdk.md 6.1.4): the engine of engine.worker.ts on the
// main thread, the last host tried and the only one of the `mediarecorder` profile. It is
// a lazy chunk of the package, loaded only when no worker starts. Messages keep their
// order and are delivered a microtask later each way, as a worker's arrive later.
import { createRecorder } from "../encode/recorder";
import { createEngine, encoderPipeline, type EngineOptions } from "./engine";
import type { EngineHost } from "./host";
import type { EngineCaps, FromEngine } from "./messages";

export function inlineHost(o: EngineOptions = {}): EngineHost {
  let h: ((m: FromEngine) => void) | undefined;
  const early: FromEngine[] = [];
  let caps: EngineCaps | undefined;
  const engine = createEngine(
    (m) => {
      if (m.k === "engine-ready") caps = m.caps;
      else queueMicrotask(() => (h ? h(m) : early.push(m)));
    },
    {
      pipeline: (m, emit) =>
        m.recorder
          ? createRecorder({
              stream: m.recorder.stream,
              mimeType: m.recorder.mime,
              emit,
              ...(m.settings ? { settings: m.settings } : {}),
            })
          : encoderPipeline(m, emit),
      ...o,
    },
  );
  return {
    kind: "inline",
    caps: caps!,
    post: (m) => queueMicrotask(() => engine.handle(m)),
    listen(fn) {
      h = fn;
      early.splice(0).forEach(fn);
    },
    terminate: () => engine.terminate(),
  };
}
