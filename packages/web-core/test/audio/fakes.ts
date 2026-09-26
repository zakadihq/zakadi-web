// Fakes of Web Audio, fetch and Cache Storage for the audio tests and the session
// tests that build on them. Install them with vi.stubGlobal: AudioContext, fetch
// and caches. The fake AudioContext runs on performance.now(), so Vitest's fake
// timers drive its clock, its sources' `onended` and the playback poll together.
import type { Manifest, PromptPackRef } from "../../src/audio/pack.js";

export const UA = {
  chrome:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  firefox:
    "Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0",
  kaios: "Mozilla/5.0 (Mobile; rv:84.0) Gecko/84.0 Firefox/84.0 KAIOS/3.0",
  safari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
} as const;

/** Clip bytes the fake decoder reads: "zk <decoded seconds> <name>". */
export function clipBytes(
  seconds: number,
  name: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`zk ${seconds} ${name}`);
}

export async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface TestPack {
  ref: PromptPackRef;
  manifest: Manifest;
  /** Every file of the pack by absolute URL, the manifest included. */
  files: Map<string, Uint8Array<ArrayBuffer>>;
  /** The URL of a cue's clip in the chosen format. */
  url(cue: string, format?: "m4a" | "ogg"): string;
}

// The tile palette of zakadi-content (catalogue/palette.toml).
export const PALETTE: [number, number, number][] = [
  [34, 45, 52],
  [65, 99, 31],
  [156, 97, 34],
  [182, 97, 34],
  [200, 94, 47],
  [243, 96, 76],
  [296, 100, 63],
  [348, 54, 66],
];

/**
 * A pack laid out as zakadi-content builds it: <base>/<lang>/<version>/manifest.json
 * with each clip beside it. `cues` maps a cue id to its manifest `dur_ms`; its clip
 * decodes 50 ms longer, as codec padding does. `raw` gives a cue other bytes, which
 * its manifest hash then covers.
 */
export async function makePack(options: {
  cues: Record<string, number>;
  lang?: string;
  version?: string;
  base?: string;
  ogg?: boolean;
  character?: unknown;
  raw?: Record<string, Uint8Array<ArrayBuffer>>;
}): Promise<TestPack> {
  const lang = options.lang ?? "en-NG";
  const version = options.version ?? "1.0.0";
  const dir = `${options.base ?? "https://cdn.zakadi.test/packs"}/${lang}/${version}/`;
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const formats: ("m4a" | "ogg")[] = options.ogg ? ["m4a", "ogg"] : ["m4a"];
  const manifest: Manifest = {
    lang,
    version,
    format: formats,
    cues: {},
    tile_palette: PALETTE,
  };
  for (const [cue, dur] of Object.entries(options.cues)) {
    const entry: Record<string, unknown> = { dur_ms: dur };
    for (const format of formats) {
      const bytes =
        options.raw?.[cue] ??
        clipBytes(dur / 1000 + 0.05, `${lang}/${cue}.${format}`);
      files.set(dir + `${cue}.${format}`, bytes);
      entry[format] = {
        file: `${cue}.${format}`,
        sha256: await sha256Hex(bytes),
      };
    }
    manifest.cues[cue] = entry as unknown as Manifest["cues"][string];
  }
  if (options.character !== undefined) {
    const bytes = new TextEncoder().encode(JSON.stringify(options.character));
    files.set(dir + "host.json", bytes);
    manifest.character = {
      lottie: "host.json",
      sha256: await sha256Hex(bytes),
      version: 3,
    };
  }
  const url = dir + "manifest.json";
  files.set(url, new TextEncoder().encode(JSON.stringify(manifest)));
  return {
    ref: { lang, version, url },
    manifest,
    files,
    url: (cue, format = "m4a") => dir + `${cue}.${format}`,
  };
}

export interface FakeFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Every requested URL, in order, with its init. */
  calls: string[];
  inits: (RequestInit | undefined)[];
  inFlight: number;
  maxInFlight: number;
  /** Which requests wait for release(); none by default. */
  hold: (url: string) => boolean;
  /** Which requests fail as a dropped connection does; none by default. */
  fail: (url: string) => boolean;
  /** Answers every held request. */
  release(): void;
  /** Requests that saw their signal abort. */
  aborted: string[];
}

/** A fetch that answers from `files`, 404 for anything else; it honours the signal. */
export function fakeFetch(
  files: Map<string, Uint8Array<ArrayBuffer>>,
): FakeFetch {
  const held: (() => void)[] = [];
  const f = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    f.calls.push(url);
    f.inits.push(init);
    f.inFlight++;
    f.maxInFlight = Math.max(f.maxInFlight, f.inFlight);
    return new Promise<Response>((resolve, reject) => {
      if (init?.signal?.aborted || f.fail(url)) {
        f.inFlight--;
        reject(
          init?.signal?.aborted
            ? new DOMException("The operation was aborted.", "AbortError")
            : new TypeError("Failed to fetch"),
        );
        return;
      }
      let settled = false;
      const answer = (): void => {
        if (settled) return;
        settled = true;
        f.inFlight--;
        const bytes = files.get(url);
        resolve(
          bytes
            ? new Response(bytes.slice())
            : new Response(null, { status: 404 }),
        );
      };
      init?.signal?.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        f.inFlight--;
        f.aborted.push(url);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
      if (f.hold(url)) held.push(answer);
      else answer();
    });
  }) as FakeFetch;
  f.calls = [];
  f.inits = [];
  f.inFlight = 0;
  f.maxInFlight = 0;
  f.hold = () => false;
  f.fail = () => false;
  f.release = () => held.splice(0).forEach((answer) => answer());
  f.aborted = [];
  return f;
}

/** One cache of Cache Storage, holding bytes by URL. */
export class FakeCache {
  readonly entries = new Map<string, Uint8Array<ArrayBuffer>>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const bytes = this.entries.get(String(request));
    return bytes ? new Response(bytes.slice()) : undefined;
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(
      String(request),
      new Uint8Array(await response.arrayBuffer()),
    );
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(String(request));
  }
}

/** Cache Storage; `refuse` makes open() reject, as a private window does. */
export class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();
  refuse = false;

  async open(name: string): Promise<FakeCache> {
    if (this.refuse) throw new DOMException("Refused.", "SecurityError");
    let cache = this.caches.get(name);
    if (!cache) this.caches.set(name, (cache = new FakeCache()));
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

export class FakeBuffer {
  readonly numberOfChannels = 1;
  readonly sampleRate = 48000;
  constructor(
    readonly duration: number,
    readonly length = Math.round(duration * 48000),
  ) {}
}

export class FakeNode {
  readonly connections: unknown[] = [];
  constructor(readonly kind: string) {}

  connect<T>(node: T): T {
    this.connections.push(node);
    return node;
  }
}

export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  /** The `when` given to start(), in context seconds. */
  when: number | undefined;
  stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ctx: FakeAudioContext) {
    super("source");
  }

  start(when = 0): void {
    this.when = when;
    this.ctx.log.push("start");
    const end =
      Math.max(when, this.ctx.currentTime) + (this.buffer?.duration ?? 0);
    this.timer = setTimeout(
      () => this.onended?.(),
      Math.round((end - this.ctx.currentTime) * 1000),
    );
  }

  stop(): void {
    if (this.when === undefined)
      throw new DOMException("Not started.", "InvalidStateError");
    this.stopped = true;
    clearTimeout(this.timer);
    setTimeout(() => this.onended?.(), 0);
  }
}

/**
 * An AudioContext whose currentTime runs on performance.now() from construction.
 * getOutputTimestamp() reports the output position `outputLag` seconds behind
 * currentTime at performance.now(); set it to undefined to remove the method.
 */
export class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  state: "suspended" | "running" | "closed" = "suspended";
  readonly sampleRate = 48000;
  outputLatency = 0.04;
  baseLatency = 0.01;
  outputLag = 0.005;
  readonly destination = new FakeNode("destination");
  /** new, resume, buffer, source, start, decode and close, in call order. */
  readonly log: string[] = [];
  readonly sources: FakeSource[] = [];
  readonly analysers: FakeNode[] = [];
  private readonly t0 = performance.now();

  constructor(readonly options?: AudioContextOptions) {
    FakeAudioContext.created.push(this);
    this.log.push("new");
  }

  get currentTime(): number {
    return (performance.now() - this.t0) / 1000;
  }

  getOutputTimestamp:
    (() => { contextTime: number; performanceTime: number }) | undefined =
    () => ({
      contextTime: this.currentTime - this.outputLag,
      performanceTime: performance.now(),
    });

  resume(): Promise<void> {
    this.log.push("resume");
    if (this.state !== "closed") this.state = "running";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.log.push("close");
    this.state = "closed";
    return Promise.resolve();
  }

  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): FakeBuffer {
    this.log.push(`buffer ${channels}x${length}`);
    return new FakeBuffer(length / sampleRate, length);
  }

  createBufferSource(): FakeSource {
    this.log.push("source");
    const source = new FakeSource(this);
    this.sources.push(source);
    return source;
  }

  createAnalyser(): FakeNode {
    const analyser = new FakeNode("analyser");
    this.analysers.push(analyser);
    return analyser;
  }

  decodeAudioData(data: ArrayBuffer): Promise<FakeBuffer> {
    this.log.push("decode");
    const match = /^zk ([\d.]+) /.exec(new TextDecoder().decode(data));
    return match
      ? Promise.resolve(new FakeBuffer(Number(match[1])))
      : Promise.reject(new DOMException("Undecodable.", "EncodingError"));
  }
}
