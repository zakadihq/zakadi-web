import {
  validateClientMsg,
  type CameraMetaMsg,
  type HelloMsg,
  type ReadyMsg,
} from "@zakadi/protocol";
import { loadVectors } from "@zakadi/protocol/vectors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngine, type Engine } from "../../src/engine/engine";
import type { FromEngine, InitMsg } from "../../src/engine/messages";
import { FakeSocket, microtaskDigest } from "../transport/fakes";
import { fromBase64url, readHeader } from "../transport/read";
import { FakePipeline, fakePipeline } from "./fakes";

// The engine of spec/06-web-sdk.md 6.2.1 on the virtual clock: ToEngine messages in,
// FromEngine messages out, over the transport of src/transport and a fake pipeline.
const happy = loadVectors().sessions.find(
  (s) => s.meta.name === "happy-two-actions",
)!;
const pick = <T>(dir: "c2s" | "s2c", t: string): T =>
  structuredClone(
    happy.lines.flatMap((l) =>
      l.dir === dir && "msg" in l && l.msg.t === t ? [l.msg] : [],
    )[0] as T,
  );
const READY = pick<ReadyMsg>("s2c", "ready");
const HELLO = pick<HelloMsg>("c2s", "hello");
const TOKEN = HELLO.token;
const A = {
  region: "eu-west-2",
  url: "wss://ingest-euw2.zakadi.dev/v1/sessions/ses_01J8VECTOR000000000001/stream",
};

const init = (o: Partial<InitMsg> = {}): InitMsg => ({
  k: "init",
  profile: "webcodecs",
  video: { kind: "frames" },
  audio: { kind: "none" },
  origin: performance.timeOrigin,
  ...o,
});

function engine(): { e: Engine; out: FromEngine[] } {
  const out: FromEngine[] = [];
  const e = createEngine((m) => out.push(m), {
    WebSocket: FakeSocket,
    pipeline: fakePipeline,
  });
  return { e, out };
}

function connect(e: Engine) {
  e.handle({
    k: "connect",
    ranked: [A],
    hello: structuredClone(HELLO),
    cameraMeta: pick<CameraMetaMsg>("c2s", "camera_meta"),
    jti: fromBase64url(happy.meta.jti),
  });
  return FakeSocket.all.at(-1)!;
}

/** Open, ready, probe_result, then `ms` of media. */
async function streaming(e: Engine, ms = 300) {
  const sock = connect(e);
  sock.open();
  sock.receive(READY);
  sock.receive({
    t: "probe_result",
    goodput_kbps: 640,
    rtt_ms: 190,
    start_rung: 2,
  });
  await vi.advanceTimersByTimeAsync(ms);
  return sock;
}

const texts = (sock: FakeSocket) => sock.texts().map((m) => m.t);

beforeEach(() => {
  vi.useFakeTimers();
  microtaskDigest();
  FakeSocket.all = [];
  FakePipeline.all = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createEngine()", () => {
  it("posts engine-ready at once with what its global scope offers", () => {
    vi.stubGlobal("MediaStreamTrackProcessor", undefined);
    vi.stubGlobal("VideoEncoder", class {});
    vi.stubGlobal("AudioEncoder", undefined);
    const { out } = engine();
    expect(out).toEqual([
      {
        k: "engine-ready",
        caps: { mstp: false, videoEncoder: true, audioEncoder: false },
      },
    ]);
  });

  it("builds the pipeline `init` asks for and starts its media clock at `ready`", async () => {
    const { e, out } = engine();
    e.handle(init());
    expect(FakePipeline.last.init.profile).toBe("webcodecs");
    const sock = await streaming(e, 400);
    expect(FakePipeline.last.calls.slice(0, 2)).toEqual([
      ["ready"],
      ["start", 2],
    ]);
    const kinds = out.map((m) => (m.k === "server" ? m.msg.t : m.k));
    expect(kinds.slice(0, 3)).toEqual(["engine-ready", "open", "ready"]);
    // The media clock starts at the first frame after ready, before the first media.
    expect(kinds.indexOf("media-clock")).toBeGreaterThan(2);
    expect(kinds.indexOf("first-media")).toBeGreaterThan(
      kinds.indexOf("media-clock"),
    );
    expect(out).toContainEqual({
      k: "telemetry",
      name: "clock_source",
      fields: { source: "shared" },
    });
    // hello first, then camera_meta, config before the first media message.
    expect(texts(sock).slice(0, 4)).toEqual([
      "hello",
      "camera_meta",
      "probe_done",
      "config",
    ]);
    for (const m of sock.texts())
      expect(validateClientMsg(m), JSON.stringify(m)).toBe(true);
  });

  it("sends the token in hello only and forwards the server's messages in order", async () => {
    const { e, out } = engine();
    e.handle(init());
    const sock = await streaming(e, 500);
    sock.receive({ t: "ui", state: { phase: "framing" } });
    sock.receive({ t: "tile", symbol: 3, min_ms: 400 });
    sock.receive({
      t: "ping",
      id: "p1",
      server_ms: 1,
      rtt_ms: 180,
      rx_kbps: 400,
    });
    const withToken = sock.sent.filter(
      (s) => s.msg && JSON.stringify(s.msg).includes(TOKEN),
    );
    expect(withToken.map((s) => s.msg!.t)).toEqual(["hello"]);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    const server = out.flatMap((m) => (m.k === "server" ? [m.msg.t] : []));
    // ping is answered in the engine and never forwarded (6.2.1).
    expect(server).toEqual(["ready", "probe_result", "ui", "tile"]);
    expect(texts(sock)).toContain("pong");
  });

  it("maps times across threads on performance.timeOrigin (6.2.5)", async () => {
    const { e, out } = engine();
    // The main thread's clock started 1000 ms before the engine's.
    e.handle(init({ origin: performance.timeOrigin - 1000 }));
    await streaming(e, 100);
    const clock = out.find((m) => m.k === "media-clock");
    expect(clock).toEqual({ k: "media-clock", t0PerfMs: 33 + 1000 });
    e.handle({ k: "clock", perfMs: 5000, ctxTime: 3.5 });
    expect(FakePipeline.last.calls).toContainEqual(["clock", 4000, 3.5]);
  });

  it("hands rVFC frames to the pipeline and closes a frame nothing takes", () => {
    const { e } = engine();
    const loose = { close: vi.fn() };
    e.handle({ k: "frame", frame: loose as unknown as VideoFrame });
    expect(loose.close).toHaveBeenCalledOnce();
    e.handle(init());
    const frame = { close: vi.fn() };
    e.handle({ k: "frame", frame: frame as unknown as VideoFrame });
    expect(FakePipeline.last.calls).toContainEqual(["frame"]);
  });

  it("sends client messages and one bye, after the final attest", async () => {
    const { e } = engine();
    e.handle(init());
    const sock = await streaming(e);
    e.handle({
      k: "client",
      msg: { t: "ui_event", event: "repeat_requested", at_ms: 300 },
    });
    e.handle({ k: "client", msg: { t: "bye", reason: "user_cancel" } });
    e.handle({ k: "client", msg: { t: "bye", reason: "unknown" } });
    await vi.advanceTimersByTimeAsync(10);
    const t = texts(sock);
    expect(t.filter((x) => x === "bye")).toHaveLength(1);
    expect(t.slice(-3)).toEqual(["ui_event", "attest", "bye"]);
    expect(FakePipeline.last.stopped).toBe(true);
    // The socket stays open for the server's end and close.
    expect(sock.closedWith).toBeNull();
  });
});

describe("stop", () => {
  it("with a bye: attest, the bye, then close 1000 once it is out (6.10)", async () => {
    const { e, out } = engine();
    e.handle(init());
    const sock = await streaming(e);
    e.handle({
      k: "stop",
      bye: { t: "bye", reason: "app_background", detail: "pagehide" },
    });
    expect(sock.closedWith).toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    expect(texts(sock).slice(-2)).toEqual(["attest", "bye"]);
    expect(sock.texts().at(-1)).toEqual({
      t: "bye",
      reason: "app_background",
      detail: "pagehide",
    });
    expect(sock.closedWith).toEqual({ code: 1000 });
    expect(out.at(-1)).toMatchObject({ k: "closed", code: 1000 });
    expect(FakePipeline.last.stopped).toBe(true);
  });

  it("after a pending bye: closes once that bye is out", async () => {
    const { e } = engine();
    e.handle(init());
    const sock = await streaming(e);
    e.handle({ k: "client", msg: { t: "bye", reason: "user_cancel" } });
    e.handle({ k: "stop" });
    expect(sock.closedWith).toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    expect(texts(sock).slice(-2)).toEqual(["attest", "bye"]);
    expect(sock.closedWith).toEqual({ code: 1000 });
  });

  it("without a bye, or after `end`: closes at once", async () => {
    const { e } = engine();
    e.handle(init());
    const sock = await streaming(e);
    sock.receive({
      t: "end",
      outcome: "completed",
      reason: "ok",
      retry: false,
    });
    await vi.advanceTimersByTimeAsync(10);
    // A bye after `end` is not sent, and does not hold the close back.
    e.handle({ k: "client", msg: { t: "bye", reason: "user_cancel" } });
    e.handle({ k: "stop", bye: { t: "bye", reason: "unknown" } });
    expect(sock.closedWith).toEqual({ code: 1000 });
    expect(texts(sock)).not.toContain("bye");
  });

  it("terminate(): closes at once, even with a bye pending", async () => {
    const { e } = engine();
    e.handle(init());
    const sock = await streaming(e);
    e.handle({ k: "client", msg: { t: "bye", reason: "user_cancel" } });
    e.terminate();
    expect(sock.closedWith).toEqual({ code: 1000 });
    expect(FakePipeline.last.stopped).toBe(true);
  });

  it("before open: drops the socket being dialled; no hello goes out", async () => {
    const { e } = engine();
    e.handle(init());
    const sock = connect(e);
    e.handle({ k: "stop", bye: { t: "bye", reason: "user_cancel" } });
    expect(sock.closedWith).toEqual({ code: 1000 });
    expect(sock.sent).toEqual([]);
    expect(FakePipeline.last.stopped).toBe(true);
  });
});

describe("failures", () => {
  it.each(["encoder_error", "capture_error"] as const)(
    "a pipeline %s: attest and the matching bye, then fatal",
    async (code) => {
      const { e, out } = engine();
      e.handle(init());
      const sock = await streaming(e);
      FakePipeline.last.fail(code);
      await vi.advanceTimersByTimeAsync(10);
      expect(texts(sock).slice(-2)).toEqual(["attest", "bye"]);
      expect(sock.texts().at(-1)).toEqual({ t: "bye", reason: code });
      expect(out.at(-1)).toEqual({ k: "fatal", code });
      expect(FakePipeline.last.stopped).toBe(true);
    },
  );

  it("a pipeline error before open: fatal only", () => {
    const { e, out } = engine();
    e.handle(init());
    FakePipeline.last.fail("capture_error");
    expect(out.at(-1)).toEqual({ k: "fatal", code: "capture_error" });
  });

  it("forwards the transport's fatal and close, and stops the pipeline", async () => {
    const { e, out } = engine();
    e.handle(init());
    const sock = await streaming(e);
    sock.serverClose(4011, "internal");
    expect(out.at(-1)).toEqual({ k: "closed", code: 4011, reason: "internal" });
    expect(FakePipeline.last.stopped).toBe(true);
    const binary = sock.sent
      .filter((s) => s.bin)
      .map((s) => readHeader(s.bin!));
    expect(binary.some((h) => h.type === 0)).toBe(true);
  });
});
