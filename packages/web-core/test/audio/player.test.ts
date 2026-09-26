import { validateAudioStateMsg } from "@zakadi/protocol";
import type { AudioStateMsg, SayMsg } from "@zakadi/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudio } from "../../src/audio/index.js";
import type { Fields } from "../../src/telemetry/index.js";
import {
  FakeAudioContext,
  FakeCacheStorage,
  fakeFetch,
  makePack,
  UA,
  type FakeSource,
} from "./fakes.js";

// spec/06-web-sdk.md 6.2.9, spec/05-sdk-contract.md 5.7 and 5.8, spec/01-protocol.md
// 1.4 audio_state and 1.5 say. Under fake timers performance.now() starts at 0; the
// fake context's output latency is 40 ms and getOutputTimestamp() puts the output
// position 5 ms behind currentTime, so context time t is heard at 1000 t + 45 ms.
const CUES = {
  "greet.intro": 1200,
  "ack.nice": 800,
  "digits.say": 1500,
  "digit.4": 600,
  "digit.7": 500,
  "action.fingers.demo": 1100,
  "count.3": 700,
  "done.thanks": 900,
  "fail.one_more_step": 1300,
  "consent.recording_notice": 1000,
};
// The media clock started at performance.now() 20.
const mediaMs = (perfMs: number): number => perfMs - 20;

function say(id: string, cue: string, more: Partial<SayMsg> = {}): SayMsg {
  return { t: "say", id, cue, ...more };
}

async function setup(
  options: {
    unlock?: boolean;
    raw?: Record<string, Uint8Array<ArrayBuffer>>;
  } = {},
) {
  const pack = await makePack({ cues: CUES, raw: options.raw ?? {} });
  vi.stubGlobal("caches", new FakeCacheStorage());
  vi.stubGlobal("fetch", fakeFetch(pack.files));
  vi.stubGlobal("navigator", { userAgent: UA.chrome });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  const sent: AudioStateMsg[] = [];
  const events: [string, Fields][] = [];
  const audio = createAudio({
    send: (msg) => sent.push(msg),
    mediaMs,
    emit: (name, fields = {}) => events.push([name, fields]),
  });
  await audio.load(pack.ref);
  vi.useFakeTimers();
  if (options.unlock !== false) audio.unlock();
  await vi.advanceTimersByTimeAsync(0);
  const ctx = FakeAudioContext.created.at(-1) as FakeAudioContext;
  // The sources of playbacks: all but the unlock's silent sample.
  const played = (): FakeSource[] => ctx.sources.slice(1);
  return { audio, ctx, sent, events, played };
}

// Each message validated against the audio_state schema, as "<re> <event> <at_ms>".
function lines(sent: AudioStateMsg[]): string[] {
  for (const msg of sent)
    expect(validateAudioStateMsg(msg), JSON.stringify(msg)).toBe(true);
  return sent.map((msg) => `${msg.re} ${msg.event} ${msg.at_ms}`);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeAudioContext.created.length = 0;
});

describe("unlock()", () => {
  it("creates and resumes the AudioContext and plays one silent sample synchronously; decoding follows", async () => {
    const { audio } = await setup({ unlock: false });
    expect(FakeAudioContext.created).toHaveLength(0);
    audio.unlock();
    const ctx = FakeAudioContext.created[0] as FakeAudioContext;
    expect(ctx.options).toEqual({ latencyHint: "interactive" });
    expect(ctx.log).toEqual([
      "new",
      "resume",
      "source",
      "buffer 1x1",
      "start",
      ...Object.keys(CUES).map(() => "decode"),
    ]);
    expect(ctx.sources[0]?.connections).toEqual([ctx.destination]);
  });

  it("resumes the same context when called again", async () => {
    const { audio, ctx } = await setup();
    audio.unlock();
    expect(FakeAudioContext.created).toHaveLength(1);
    expect(ctx.log.filter((entry) => entry === "resume")).toHaveLength(2);
    expect(ctx.log.filter((entry) => entry === "decode")).toHaveLength(
      Object.keys(CUES).length,
    );
  });

  it("decodes the clips that arrive after it as they arrive", async () => {
    const pack = await makePack({ cues: CUES });
    vi.stubGlobal("caches", new FakeCacheStorage());
    vi.stubGlobal("fetch", fakeFetch(pack.files));
    vi.stubGlobal("navigator", { userAgent: UA.chrome });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const audio = createAudio({ send: () => {}, mediaMs, emit: () => {} });
    audio.unlock();
    await audio.load(pack.ref);
    const ctx = FakeAudioContext.created[0] as FakeAudioContext;
    expect(ctx.log.filter((entry) => entry === "decode")).toHaveLength(
      Object.keys(CUES).length,
    );
  });
});

describe("say", () => {
  it("schedules the cue and its digit.N clips from currentTime + 0.03, each at the previous start plus dur_ms plus 120 ms", async () => {
    const { audio, played } = await setup();
    await vi.advanceTimersByTimeAsync(1000);
    audio.say(say("s1", "digits.say", { params: { digits: [4, 7] } }));
    await vi.advanceTimersByTimeAsync(0);
    // The manifest durations set the gaps, not the decoded lengths (50 ms longer).
    const whens = [1.03, 1.03 + 1.5 + 0.12, 1.03 + 1.5 + 0.12 + 0.6 + 0.12];
    expect(played()).toHaveLength(3);
    played().forEach((source, i) =>
      expect(source.when).toBeCloseTo(whens[i] ?? NaN, 9),
    );
    [1.55, 0.65, 0.55].forEach((duration, i) =>
      expect(played()[i]?.buffer?.duration).toBeCloseTo(duration, 9),
    );
  });

  it("follows the cue with count.N for params.count", async () => {
    const { audio, played } = await setup();
    audio.say(say("s1", "action.fingers.demo", { params: { count: 3 } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(played()).toHaveLength(2);
    expect(played()[0]?.when).toBeCloseTo(0.03, 9);
    expect(played()[1]?.when).toBeCloseTo(0.03 + 1.1 + 0.12, 9);
  });

  it("sends one started at the first 10 ms poll past the start, at_ms its audible time on the media clock", async () => {
    const { audio, sent, events } = await setup();
    audio.say(say("s1", "greet.intro"));
    await vi.advanceTimersByTimeAsync(20);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    // Starts at 0.03 s, heard at 75 ms: 55 on the media clock.
    expect(lines(sent)).toEqual(["s1 started 55"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(lines(sent)).toEqual(["s1 started 55"]);
    expect(events).toContainEqual([
      "cue_play",
      { cue: "greet.intro", ms_to_start: 75 },
    ]);
  });

  it("maps through currentTime and baseLatency where getOutputTimestamp() and outputLatency are missing", async () => {
    const { audio, ctx, sent } = await setup();
    ctx.getOutputTimestamp = undefined;
    ctx.outputLatency = 0;
    audio.say(say("s1", "greet.intro"));
    await vi.advanceTimersByTimeAsync(30);
    // 0.03 s plus the 10 ms base latency: heard at 40 ms.
    expect(lines(sent)).toEqual(["s1 started 20"]);
  });

  it("sends one ended at the last source's onended, at the end of its audio", async () => {
    const { audio, sent } = await setup();
    audio.say(say("s1", "digits.say", { params: { digits: [4, 7] } }));
    await vi.advanceTimersByTimeAsync(2900);
    expect(lines(sent)).toEqual(["s1 started 55"]);
    await vi.advanceTimersByTimeAsync(100);
    // The last clip starts at 2.37 s and its audio ends 0.55 s later, heard at 2965 ms.
    expect(lines(sent)).toEqual(["s1 started 55", "s1 ended 2945"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(2);
  });

  it("queues a say that arrives during a playback", async () => {
    const { audio, sent, played } = await setup();
    audio.say(say("s1", "greet.intro"));
    await vi.advanceTimersByTimeAsync(100);
    audio.say(say("s2", "ack.nice"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(played()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    // s1 ends at 1.28 s; s2 starts 30 ms later and lasts 0.85 s.
    expect(played()[1]?.when).toBeCloseTo(1.31, 9);
    expect(lines(sent)).toEqual([
      "s1 started 55",
      "s1 ended 1305",
      "s2 started 1335",
      "s2 ended 2185",
    ]);
  });

  it("stops the current playback for an interrupting say, which plays at once; queued says keep their turn", async () => {
    const { audio, sent, played } = await setup();
    audio.say(say("s1", "digits.say", { params: { digits: [4, 7] } }));
    audio.say(say("s2", "greet.intro"));
    await vi.advanceTimersByTimeAsync(500);
    audio.say(say("s3", "ack.nice", { interrupt: true }));
    // s1 ends where it stands, at 0.5 s, heard at 545 ms.
    expect(lines(sent)).toEqual(["s1 started 55", "s1 ended 525"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      played()
        .slice(0, 3)
        .map((source) => source.stopped),
    ).toEqual([true, true, true]);
    expect(played()[3]?.when).toBeCloseTo(0.53, 9);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lines(sent)).toEqual([
      "s1 started 55",
      "s1 ended 525",
      "s3 started 555",
      "s3 ended 1405",
      "s2 started 1435",
      "s2 ended 2685",
    ]);
  });

  it("sends failed and cue_missing for a cue the pack lacks", async () => {
    const { audio, sent, events, played } = await setup();
    audio.say(say("s1", "light.window"));
    await vi.advanceTimersByTimeAsync(100);
    expect(lines(sent)).toEqual(["s1 failed 0"]);
    expect(events).toContainEqual([
      "cue_missing",
      { cue: "light.window", reason: "not_in_pack" },
    ]);
    expect(played()).toEqual([]);
  });

  it("fails the whole playback when one of its digit clips is missing", async () => {
    const { audio, sent, events, played } = await setup();
    await vi.advanceTimersByTimeAsync(100);
    audio.say(say("s1", "digits.say", { params: { digits: [4, 9] } }));
    await vi.advanceTimersByTimeAsync(100);
    expect(lines(sent)).toEqual(["s1 failed 80"]);
    expect(events).toContainEqual([
      "cue_missing",
      { cue: "digit.9", reason: "not_in_pack" },
    ]);
    expect(played()).toEqual([]);
  });

  it("treats a clip that does not decode as missing", async () => {
    const { audio, sent, events } = await setup({
      raw: { "ack.nice": new TextEncoder().encode("not audio") },
    });
    audio.say(say("s1", "ack.nice"));
    await vi.advanceTimersByTimeAsync(100);
    expect(lines(sent)).toEqual(["s1 failed 0"]);
    expect(events).toContainEqual([
      "cue_missing",
      { cue: "ack.nice", reason: "decode" },
    ]);
  });

  it("sends failed when the context is not running", async () => {
    const { audio, ctx, sent, events } = await setup();
    ctx.state = "suspended";
    audio.say(say("s1", "greet.intro"));
    await vi.advanceTimersByTimeAsync(100);
    expect(lines(sent)).toEqual(["s1 failed 0"]);
    expect(events.filter(([name]) => name === "cue_missing")).toEqual([]);
  });

  it("sends failed before the unlock", async () => {
    const { audio, sent } = await setup({ unlock: false });
    audio.say(say("s1", "greet.intro"));
    await vi.advanceTimersByTimeAsync(100);
    expect(lines(sent)).toEqual(["s1 failed 0"]);
  });
});

describe("cues without a say", () => {
  it("never plays a cue on its own", async () => {
    const { ctx, sent, played } = await setup();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(played()).toEqual([]);
    expect(ctx.sources).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("plays consent.recording_notice on request, with no audio_state", async () => {
    const { audio, sent, events, played } = await setup();
    audio.notice();
    await vi.advanceTimersByTimeAsync(2000);
    expect(played()).toHaveLength(1);
    expect(played()[0]?.buffer?.duration).toBeCloseTo(1.05, 9);
    expect(sent).toEqual([]);
    expect(events).toContainEqual([
      "cue_play",
      { cue: "consent.recording_notice", ms_to_start: 75 },
    ]);
  });

  it("plays a terminal state's cue on request when no say arrived in the 3 s before", async () => {
    const { audio, sent, played } = await setup();
    expect(audio.terminal("completed")).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    // done.thanks: 900 ms in the manifest, decoded 0.95 s.
    expect(played()).toHaveLength(1);
    expect(played()[0]?.buffer?.duration).toBeCloseTo(0.95, 9);
    expect(sent).toEqual([]);
  });

  it("leaves the server's closing cue when a say arrived in the 3 s before", async () => {
    const { audio, played } = await setup();
    audio.say(say("s1", "ack.nice"));
    await vi.advanceTimersByTimeAsync(2999);
    expect(audio.terminal("incomplete")).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(played()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(audio.terminal("incomplete")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    // fail.one_more_step: 1300 ms in the manifest, decoded 1.35 s.
    expect(played()[1]?.buffer?.duration).toBeCloseTo(1.35, 9);
  });
});

describe("the playback bus", () => {
  it("routes every playback through an AnalyserNode to the output", async () => {
    const { audio, ctx, played } = await setup();
    const analyser = ctx.analysers[0];
    expect(audio.analyser).toBe(analyser);
    expect(analyser?.connections).toEqual([ctx.destination]);
    audio.say(say("s1", "digits.say", { params: { digits: [4, 7] } }));
    await vi.advanceTimersByTimeAsync(0);
    for (const source of played())
      expect(source.connections).toEqual([analyser]);
  });

  it("is null before the unlock", async () => {
    const { audio } = await setup({ unlock: false });
    expect(audio.analyser).toBeNull();
  });

  it("stops and closes on dispose() and sends nothing more", async () => {
    const { audio, ctx, sent, played } = await setup();
    audio.say(say("s1", "greet.intro"));
    await vi.advanceTimersByTimeAsync(100);
    audio.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(lines(sent)).toEqual(["s1 started 55"]);
    expect(played()[0]?.stopped).toBe(true);
    expect(ctx.state).toBe("closed");
    expect(audio.analyser).toBeNull();
  });
});
