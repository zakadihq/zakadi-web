// Where the engine runs (spec/06-web-sdk.md 6.1.4), chosen on the main thread in this
// order: `config.workerUrl`, then createEngineWorker() of dist/worker-url.js, then the
// engine inline on the main thread, loaded as a lazy chunk. The Blob worker of the CDN
// build is not part of this package. A worker that throws on construction, fires
// `error` or posts no `engine-ready` within 3 s is terminated and the next one tried.
import type { Fields, TelemetryName } from "../telemetry/index";
import { createEngineWorker } from "../worker-url.js";
import type { EngineCaps, FromEngine, Profile, ToEngine } from "./messages";

export type HostKind = "worker_url" | "module" | "inline";

export interface EngineHost {
  readonly kind: HostKind;
  readonly caps: EngineCaps;
  post(m: ToEngine, transfer?: Transferable[]): void;
  /** Hands every later engine message to `h`, in order; a crash arrives as fatal `internal`. */
  listen(h: (m: FromEngine) => void): void;
  terminate(): void;
}

export interface HostOptions {
  profile: Profile;
  /** A same-origin self-hosted engine.worker.js (6.1.4, 6.6.3). */
  workerUrl?: string | undefined;
  /** Receives the `engine_host` telemetry. */
  emit(name: TelemetryName, fields: Fields): void;
}

const READY_MS = 3000;

type Policy = { createScriptURL(url: string): unknown };
let policy: Policy | null | undefined;

// Under Trusted Types enforcement a worker comes only from `workerUrl`, through a policy
// named `liveness` (6.1.4, 6.7); created once, as a second policy of that name throws.
function trusted(url: string): string {
  if (policy === undefined) {
    try {
      const tt = (
        globalThis as {
          trustedTypes?: {
            createPolicy(
              n: string,
              p: { createScriptURL(u: string): string },
            ): Policy;
          };
        }
      ).trustedTypes;
      policy =
        tt?.createPolicy("liveness", { createScriptURL: (u) => u }) ?? null;
    } catch {
      policy = null;
    }
  }
  return (policy?.createScriptURL(url) ?? url) as string;
}

/** A worker that posted `engine-ready` within 3 s, or null. */
export function workerHost(
  kind: HostKind,
  make: () => Worker,
): Promise<EngineHost | null> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = make();
    } catch {
      return resolve(null);
    }
    let h: ((m: FromEngine) => void) | undefined;
    let early: FromEngine[] | undefined;
    const give = (m: FromEngine) => (h ? h(m) : early?.push(m));
    const drop = () => {
      clearTimeout(timer);
      w.terminate();
      resolve(null);
    };
    const timer = setTimeout(drop, READY_MS);
    const crash = (e: Event) => {
      e.preventDefault();
      if (early) give({ k: "fatal", code: "internal" });
      else drop();
    };
    w.onerror = crash;
    w.onmessageerror = crash;
    w.onmessage = ({ data }: MessageEvent<FromEngine>) => {
      if (early) return give(data);
      if (data?.k !== "engine-ready") return;
      clearTimeout(timer);
      early = [];
      resolve({
        kind,
        caps: data.caps,
        post: (m, transfer = []) => w.postMessage(m, transfer),
        listen(fn) {
          h = fn;
          early!.splice(0).forEach(fn);
        },
        terminate: () => w.terminate(),
      });
    };
  });
}

/**
 * The first engine host that starts, in the 6.1.4 order; the `mediarecorder` profile
 * always runs inline. Reports the choice as `engine_host` telemetry.
 */
export async function pickHost(o: HostOptions): Promise<EngineHost> {
  const t0 = performance.now();
  let failed = 0;
  const done = (h: EngineHost): EngineHost => {
    o.emit("engine_host", {
      host: h.kind,
      failed,
      ms: Math.round(performance.now() - t0),
    });
    return h;
  };
  if (o.profile === "webcodecs") {
    const tries: [HostKind, () => Worker][] = [["module", createEngineWorker]];
    const url = o.workerUrl;
    if (url)
      tries.unshift([
        "worker_url",
        () => new Worker(trusted(url), { name: "zakadi-engine" }),
      ]);
    for (const [kind, make] of tries) {
      const h = await workerHost(kind, make);
      if (h) return done(h);
      failed++;
    }
  }
  const { inlineHost } = await import("./inline");
  return done(inlineHost());
}
