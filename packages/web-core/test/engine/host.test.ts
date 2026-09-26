import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickHost, workerHost } from "../../src/engine/host";
import type { FromEngine } from "../../src/engine/messages";
import type { Fields } from "../../src/telemetry/index";
import { FakeWorker } from "./fakes";

// Where the engine runs (spec/06-web-sdk.md 6.1.4): `workerUrl`, createEngineWorker(),
// then inline; 3 s for engine-ready; the mediarecorder profile inline; `engine_host`.
function pick(
  o: { profile?: "webcodecs" | "mediarecorder"; workerUrl?: string } = {},
) {
  const telemetry: [string, Fields][] = [];
  const host = pickHost({
    profile: o.profile ?? "webcodecs",
    workerUrl: o.workerUrl,
    emit: (name, fields) => telemetry.push([name, fields]),
  });
  return { host, telemetry };
}

const url = (w: FakeWorker) => String(w.url);

beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.all = [];
  FakeWorker.script = [];
  FakeWorker.delay = 10;
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pickHost()", () => {
  it("takes config.workerUrl first, as a named classic worker", async () => {
    const { host, telemetry } = pick({
      workerUrl: "/liveness/engine.worker.js",
    });
    await vi.advanceTimersByTimeAsync(10);
    const h = await host;
    expect(h.kind).toBe("worker_url");
    expect(FakeWorker.all).toHaveLength(1);
    expect(url(FakeWorker.all[0]!)).toBe("/liveness/engine.worker.js");
    expect(FakeWorker.all[0]!.options).toEqual({ name: "zakadi-engine" });
    expect(h.caps).toEqual({
      mstp: true,
      videoEncoder: true,
      audioEncoder: true,
    });
    expect(telemetry).toEqual([
      ["engine_host", { host: "worker_url", failed: 0, ms: 10 }],
    ]);
  });

  it("then createEngineWorker(): dist/engine.worker.js next to worker-url.js, as a module", async () => {
    const { host } = pick();
    await vi.advanceTimersByTimeAsync(10);
    const h = await host;
    expect(h.kind).toBe("module");
    expect(url(FakeWorker.all[0]!)).toMatch(/\/engine\.worker\.js$/);
    expect(FakeWorker.all[0]!.options).toEqual({
      type: "module",
      name: "zakadi-engine",
    });
  });

  it("moves on from a worker that throws, fires error or stays silent for 3 s", async () => {
    FakeWorker.script = ["throw", "silent"];
    const first = pick({ workerUrl: "/w.js" });
    await vi.advanceTimersByTimeAsync(2999);
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.all[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // The silent module worker was terminated at 3 s: the inline engine runs.
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    const h = await first.host;
    expect(h.kind).toBe("inline");
    expect(first.telemetry).toEqual([
      ["engine_host", { host: "inline", failed: 2, ms: 3000 }],
    ]);

    FakeWorker.all = [];
    FakeWorker.script = ["error", "ready"];
    const second = pick({ workerUrl: "/w.js" });
    await vi.advanceTimersByTimeAsync(20);
    expect((await second.host).kind).toBe("module");
    expect(FakeWorker.all[0]!.terminated).toBe(true);
  });

  it("runs the mediarecorder profile inline, without a worker", async () => {
    const { host, telemetry } = pick({
      profile: "mediarecorder",
      workerUrl: "/w.js",
    });
    const h = await host;
    expect(h.kind).toBe("inline");
    expect(FakeWorker.all).toHaveLength(0);
    expect(telemetry[0]![1]).toMatchObject({ host: "inline", failed: 0 });
  });

  it("creates workerUrl's worker through a Trusted Types policy named liveness", async () => {
    const createPolicy = vi.fn(
      (_name: string, p: { createScriptURL(u: string): string }) => ({
        createScriptURL: (u: string) => ({ trusted: p.createScriptURL(u) }),
      }),
    );
    vi.stubGlobal("trustedTypes", { createPolicy });
    // The policy is created once per page: a fresh copy of the module.
    vi.resetModules();
    const fresh = await import("../../src/engine/host");
    const host = fresh.pickHost({
      profile: "webcodecs",
      workerUrl: "/w.js",
      emit: () => {},
    });
    await vi.advanceTimersByTimeAsync(10);
    await host;
    const again = fresh.pickHost({
      profile: "webcodecs",
      workerUrl: "/w.js",
      emit: () => {},
    });
    await vi.advanceTimersByTimeAsync(10);
    await again;
    expect(createPolicy).toHaveBeenCalledOnce();
    expect(createPolicy).toHaveBeenCalledWith("liveness", expect.anything());
    expect(FakeWorker.all[0]!.url).toEqual({ trusted: "/w.js" });
  });
});

describe("workerHost()", () => {
  it("keeps the engine's messages until listen() and then delivers them in order", async () => {
    const pending = workerHost("module", () => new Worker("/w.js"));
    await vi.advanceTimersByTimeAsync(10);
    const h = (await pending)!;
    const w = FakeWorker.all[0]!;
    w.send({ k: "open", region: "eu-west-2", ms: 80 });
    w.send({ k: "first-media" });
    const got: FromEngine[] = [];
    h.listen((m) => got.push(m));
    w.send({ k: "closed", code: 1000, reason: "" });
    expect(got.map((m) => m.k)).toEqual(["open", "first-media", "closed"]);
    h.post({ k: "stop" }, []);
    expect(w.posted).toEqual([[{ k: "stop" }, []]]);
    h.terminate();
    expect(w.terminated).toBe(true);
  });

  it("reports a crash after engine-ready as fatal internal", async () => {
    const pending = workerHost("module", () => new Worker("/w.js"));
    await vi.advanceTimersByTimeAsync(10);
    const h = (await pending)!;
    const got: FromEngine[] = [];
    h.listen((m) => got.push(m));
    FakeWorker.all[0]!.crash();
    expect(got).toEqual([{ k: "fatal", code: "internal" }]);
  });
});
