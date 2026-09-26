// The engine worker (spec/06-web-sdk.md 6.1.4, 6.2.1): built by vite.worker.config.ts as
// the single file dist/engine.worker.js, without import, export or import.meta, so that
// it runs whether a host bundler emits it as a module or a classic worker. It is type
// checked with tsconfig.worker.json against the WebWorker library.
import { createEngine } from "./engine";
import type { ToEngine } from "./messages";

declare const self: DedicatedWorkerGlobalScope;

const engine = createEngine((m) => self.postMessage(m));
self.onmessage = (e: MessageEvent<ToEngine>) => engine.handle(e.data);
