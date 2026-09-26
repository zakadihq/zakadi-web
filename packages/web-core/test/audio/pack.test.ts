import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudio, PackUnavailableError } from "../../src/audio/index.js";
import { engineOf } from "../../src/audio/pack.js";
import type { Fields } from "../../src/telemetry/index.js";
import {
  FakeAudioContext,
  FakeCacheStorage,
  fakeFetch,
  makePack,
  UA,
  type TestPack,
} from "./fakes.js";

// spec/06-web-sdk.md 6.2.9 and spec/05-sdk-contract.md 5.7, with the manifest as
// zakadi-content writes it (m4a only, no character) unless a test adds more.
const CUES = {
  "greet.intro": 1200,
  "frame.hold_still": 900,
  "digit.4": 600,
};

function stub(pack: TestPack, userAgent: string = UA.chrome) {
  const storage = new FakeCacheStorage();
  const fetch = fakeFetch(pack.files);
  vi.stubGlobal("caches", storage);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("navigator", { userAgent });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  return { storage, fetch };
}

function audioWith(events: [string, Fields][] = []) {
  return createAudio({
    send: () => {},
    mediaMs: (perfMs) => perfMs,
    emit: (name, fields = {}) => events.push([name, fields]),
  });
}

// Plays a say for `cue` and reports whether its clip was scheduled.
async function plays(audio: ReturnType<typeof createAudio>, cue: string) {
  audio.unlock();
  const ctx = FakeAudioContext.created.at(-1) as FakeAudioContext;
  const before = ctx.sources.length;
  audio.say({ t: "say", id: "s1", cue });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return ctx.sources.length > before;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeAudioContext.created.length = 0;
});

describe("loading the pack", () => {
  it("loads the manifest and every clip into Cache Storage zakadi-pack:<lang>@<version>", async () => {
    const pack = await makePack({ cues: CUES });
    const { storage, fetch } = stub(pack);
    const events: [string, Fields][] = [];
    const loaded = await audioWith(events).load(pack.ref);
    expect(loaded).toEqual({ manifest: pack.manifest, character: null });
    const clips = Object.keys(CUES).map((cue) => pack.url(cue));
    expect(fetch.calls).toEqual([pack.ref.url, ...clips]);
    for (const init of fetch.inits) expect(init?.credentials).toBe("omit");
    expect([...storage.caches.keys()]).toEqual(["zakadi-pack:en-NG@1.0.0"]);
    const cache = storage.caches.get("zakadi-pack:en-NG@1.0.0");
    expect([...(cache?.entries.keys() ?? [])].sort()).toEqual(
      [pack.ref.url, ...clips].sort(),
    );
    for (const [url, bytes] of cache?.entries ?? [])
      expect(bytes).toEqual(pack.files.get(url));
    expect(events).toContainEqual([
      "pack_fetch",
      { ms: expect.any(Number), cached: false },
    ]);
  });

  it("reads a pack an earlier session cached without a request", async () => {
    const pack = await makePack({ cues: CUES });
    const { storage } = stub(pack);
    await audioWith().load(pack.ref);
    const fetch = fakeFetch(pack.files);
    vi.stubGlobal("fetch", fetch);
    const events: [string, Fields][] = [];
    const audio = audioWith(events);
    await audio.load(pack.ref);
    expect(fetch.calls).toEqual([]);
    expect(events).toContainEqual([
      "pack_fetch",
      { ms: expect.any(Number), cached: true },
    ]);
    expect(storage.caches.size).toBe(1);
    expect(await plays(audio, "greet.intro")).toBe(true);
  });

  it("requests six files at a time", async () => {
    const cues = Object.fromEntries(
      Array.from({ length: 14 }, (_, i) => [`frame.cue_${i}`, 500]),
    );
    const pack = await makePack({ cues });
    const { fetch } = stub(pack);
    fetch.hold = (url) => url.endsWith(".m4a");
    let done = false;
    const loading = audioWith()
      .load(pack.ref)
      .then(() => (done = true));
    await vi.waitFor(() => expect(fetch.inFlight).toBe(6));
    while (!done) {
      fetch.release();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await loading;
    expect(fetch.maxInFlight).toBe(6);
    expect(fetch.calls).toHaveLength(15);
  });

  it("stops at 5 s and leaves the clips still loading to play caption-only", async () => {
    const pack = await makePack({ cues: CUES });
    const { fetch } = stub(pack);
    fetch.hold = (url) => url.endsWith(".m4a");
    vi.useFakeTimers();
    const events: [string, Fields][] = [];
    const audio = audioWith(events);
    let loaded = false;
    const loading = audio.load(pack.ref).then(() => (loaded = true));
    await vi.advanceTimersByTimeAsync(4999);
    expect(loaded).toBe(false);
    expect(fetch.inFlight).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    await loading;
    expect(fetch.aborted).toEqual(
      Object.keys(CUES).map((cue) => pack.url(cue)),
    );
    audio.unlock();
    audio.say({ t: "say", id: "s1", cue: "greet.intro" });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual([
      "cue_missing",
      { cue: "greet.intro", reason: "not_loaded" },
    ]);
  });

  it("deletes the older versions of its language and nothing else", async () => {
    const pack = await makePack({ cues: CUES, version: "1.1.0" });
    const { storage } = stub(pack);
    for (const name of [
      "zakadi-pack:en-NG@1.0.0",
      "zakadi-pack:fr-CI@1.0.0",
      "zakadi-pack:en@1.0.0",
      "another-cache",
    ])
      await storage.open(name);
    await audioWith().load(pack.ref);
    await vi.waitFor(async () =>
      expect(await storage.has("zakadi-pack:en-NG@1.0.0")).toBe(false),
    );
    expect([...storage.caches.keys()].sort()).toEqual([
      "another-cache",
      "zakadi-pack:en-NG@1.1.0",
      "zakadi-pack:en@1.0.0",
      "zakadi-pack:fr-CI@1.0.0",
    ]);
  });

  it("keeps the pack in memory where caches.open() throws", async () => {
    const pack = await makePack({ cues: CUES });
    const { storage } = stub(pack);
    storage.refuse = true;
    const audio = audioWith();
    await audio.load(pack.ref);
    expect(storage.caches.size).toBe(0);
    expect(await plays(audio, "greet.intro")).toBe(true);
  });

  it("keeps the pack in memory where Cache Storage does not exist", async () => {
    const pack = await makePack({ cues: CUES });
    stub(pack);
    vi.stubGlobal("caches", undefined);
    const audio = audioWith();
    await audio.load(pack.ref);
    expect(await plays(audio, "greet.intro")).toBe(true);
  });

  it("loads the language chosen on the consent screen the same way, and plays it", async () => {
    const en = await makePack({ cues: CUES });
    const fr = await makePack({ cues: { "greet.intro": 1500 }, lang: "fr-CI" });
    const { storage } = stub(en);
    const both = fakeFetch(new Map([...en.files, ...fr.files]));
    both.hold = (url) => url.includes("/en-NG/") && url.endsWith(".m4a");
    vi.stubGlobal("fetch", both);
    const events: [string, Fields][] = [];
    const audio = audioWith(events);
    const first = audio.load(en.ref);
    await vi.waitFor(() => expect(both.inFlight).toBe(3));
    const loaded = await audio.load(fr.ref);
    await first;
    expect(loaded.manifest.lang).toBe("fr-CI");
    expect(storage.caches.has("zakadi-pack:fr-CI@1.0.0")).toBe(true);
    expect(storage.caches.get("zakadi-pack:fr-CI@1.0.0")?.entries.size).toBe(2);
    // The English requests still in flight are abandoned, and report nothing.
    expect(both.aborted).toHaveLength(3);
    expect(events.filter(([name]) => name === "pack_fetch")).toHaveLength(1);
    audio.unlock();
    const ctx = FakeAudioContext.created[0] as FakeAudioContext;
    audio.say({ t: "say", id: "s1", cue: "greet.intro" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.sources[1]?.buffer?.duration).toBeCloseTo(1.55, 9);
  });
});

describe("hash checks", () => {
  it("neither caches nor plays a clip that fails its SHA-256", async () => {
    const pack = await makePack({ cues: CUES });
    pack.files.set(
      pack.url("greet.intro"),
      new TextEncoder().encode("zk 1.25 tampered"),
    );
    const { storage } = stub(pack);
    const events: [string, Fields][] = [];
    const audio = audioWith(events);
    await audio.load(pack.ref);
    const cache = storage.caches.get("zakadi-pack:en-NG@1.0.0");
    expect(cache?.entries.has(pack.url("greet.intro"))).toBe(false);
    expect(cache?.entries.has(pack.url("frame.hold_still"))).toBe(true);
    expect(await plays(audio, "greet.intro")).toBe(false);
    expect(events).toContainEqual([
      "cue_missing",
      { cue: "greet.intro", reason: "sha256" },
    ]);
  });

  it("checks a cached clip again when it reads it back", async () => {
    const pack = await makePack({ cues: CUES });
    const { storage } = stub(pack);
    await audioWith().load(pack.ref);
    const cache = storage.caches.get("zakadi-pack:en-NG@1.0.0");
    cache?.entries.set(
      pack.url("greet.intro"),
      new TextEncoder().encode("zk 1.25 rotten"),
    );
    const fetch = fakeFetch(pack.files);
    vi.stubGlobal("fetch", fetch);
    const events: [string, Fields][] = [];
    const audio = audioWith(events);
    await audio.load(pack.ref);
    expect(cache?.entries.has(pack.url("greet.intro"))).toBe(false);
    expect(await plays(audio, "greet.intro")).toBe(false);
    expect(events).toContainEqual([
      "cue_missing",
      { cue: "greet.intro", reason: "sha256" },
    ]);
    expect(await plays(audio, "frame.hold_still")).toBe(true);
  });

  it("checks the character JSON like every other file", async () => {
    const character = { v: "5.13.0", layers: [] };
    const pack = await makePack({ cues: CUES, character });
    const { storage } = stub(pack);
    const loaded = await audioWith().load(pack.ref);
    expect(loaded.character).toEqual(character);
    const url = "https://cdn.zakadi.test/packs/en-NG/1.0.0/host.json";
    expect(
      storage.caches.get("zakadi-pack:en-NG@1.0.0")?.entries.has(url),
    ).toBe(true);

    pack.files.set(
      url,
      new TextEncoder().encode('{"v":"5.13.0","layers":[1]}'),
    );
    const other = stub(pack);
    const events: [string, Fields][] = [];
    const tampered = await audioWith(events).load(pack.ref);
    expect(tampered.character).toBeNull();
    expect(
      other.storage.caches.get("zakadi-pack:en-NG@1.0.0")?.entries.has(url),
    ).toBe(false);
    expect(events).toContainEqual([
      "cue_missing",
      { cue: "character", reason: "sha256" },
    ]);
  });

  it.each([
    [
      "a manifest that is not JSON",
      (pack: TestPack) =>
        pack.files.set(pack.ref.url, new TextEncoder().encode("<html>")),
    ],
    [
      "a manifest of another language",
      (pack: TestPack) =>
        pack.files.set(
          pack.ref.url,
          new TextEncoder().encode(
            JSON.stringify({ ...pack.manifest, lang: "fr-CI" }),
          ),
        ),
    ],
    [
      "a manifest without its eight palette entries",
      (pack: TestPack) =>
        pack.files.set(
          pack.ref.url,
          new TextEncoder().encode(
            JSON.stringify({
              ...pack.manifest,
              tile_palette: pack.manifest.tile_palette.slice(1),
            }),
          ),
        ),
    ],
  ])("rejects with pack_unavailable at once for %s", async (_name, spoil) => {
    const pack = await makePack({ cues: CUES });
    spoil(pack);
    const { fetch } = stub(pack);
    const error = await audioWith()
      .load(pack.ref)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PackUnavailableError);
    expect((error as PackUnavailableError).code).toBe("pack_unavailable");
    expect(fetch.calls).toEqual([pack.ref.url]);
  });

  it.each([
    ["a manifest the server does not have", "404"],
    ["a connection that drops every request", "drop"],
  ])(
    "asks again every second and rejects with pack_unavailable at 5 s for %s",
    async (_name, failure) => {
      const pack = await makePack({ cues: CUES });
      const { fetch } = stub(pack);
      if (failure === "404") pack.files.delete(pack.ref.url);
      else fetch.fail = () => true;
      vi.useFakeTimers();
      let error: unknown;
      const loading = audioWith()
        .load(pack.ref)
        .catch((e: unknown) => (error = e));
      await vi.advanceTimersByTimeAsync(4999);
      expect(error).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await loading;
      expect(error).toBeInstanceOf(PackUnavailableError);
      expect(fetch.calls).toEqual(Array(5).fill(pack.ref.url));
    },
  );

  it("loads a manifest that arrives on a later request", async () => {
    const pack = await makePack({ cues: CUES });
    const { fetch } = stub(pack);
    fetch.fail = () => fetch.calls.length === 1;
    vi.useFakeTimers();
    const loading = audioWith().load(pack.ref);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await loading).manifest).toEqual(pack.manifest);
    expect(fetch.calls.slice(0, 2)).toEqual([pack.ref.url, pack.ref.url]);
  });

  it("rejects with pack_unavailable when no manifest arrives within 5 s", async () => {
    const pack = await makePack({ cues: CUES });
    const { fetch } = stub(pack);
    fetch.hold = () => true;
    vi.useFakeTimers();
    let error: unknown;
    const loading = audioWith()
      .load(pack.ref)
      .catch((e: unknown) => (error = e));
    await vi.advanceTimersByTimeAsync(4999);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await loading;
    expect(error).toBeInstanceOf(PackUnavailableError);
    expect(fetch.aborted).toEqual([pack.ref.url]);
  });
});

describe("the audio format", () => {
  it.each([
    [UA.chrome, "chromium"],
    [UA.samsung, "chromium"],
    [UA.firefox, "gecko"],
    [UA.kaios, "gecko"],
    [UA.safari, "webkit"],
    [UA.safariMac, "webkit"],
    [UA.chromeIos, "webkit"],
  ])("reads the engine of %s as %s", (userAgent, engine) => {
    expect(engineOf(userAgent)).toBe(engine);
  });

  it.each([
    ["Chrome for Android", UA.chrome, "ogg"],
    ["Samsung Internet", UA.samsung, "ogg"],
    ["Firefox for Android", UA.firefox, "ogg"],
    ["KaiOS", UA.kaios, "ogg"],
    ["Safari on iOS", UA.safari, "m4a"],
    ["Safari on macOS", UA.safariMac, "m4a"],
    ["Chrome on iOS", UA.chromeIos, "m4a"],
  ])(
    "plays %s the %s clips of a pack that lists ogg",
    async (_name, userAgent, format) => {
      const pack = await makePack({ cues: CUES, ogg: true });
      const { fetch } = stub(pack, userAgent);
      await audioWith().load(pack.ref);
      expect(fetch.calls.slice(1)).toEqual(
        Object.keys(CUES).map((cue) => pack.url(cue, format as "m4a" | "ogg")),
      );
    },
  );

  it("plays m4a on Chromium when the pack lists m4a alone", async () => {
    const pack = await makePack({ cues: CUES });
    const { fetch } = stub(pack, UA.chrome);
    await audioWith().load(pack.ref);
    expect(fetch.calls.slice(1).every((url) => url.endsWith(".m4a"))).toBe(
      true,
    );
  });

  it("plays m4a for a cue that has no ogg entry in a pack that lists ogg", async () => {
    const pack = await makePack({ cues: CUES, ogg: true });
    delete pack.manifest.cues["digit.4"]?.ogg;
    pack.files.set(
      pack.ref.url,
      new TextEncoder().encode(JSON.stringify(pack.manifest)),
    );
    const { fetch } = stub(pack, UA.firefox);
    await audioWith().load(pack.ref);
    expect(fetch.calls.slice(1)).toEqual([
      pack.url("greet.intro", "ogg"),
      pack.url("frame.hold_still", "ogg"),
      pack.url("digit.4", "m4a"),
    ]);
  });
});
