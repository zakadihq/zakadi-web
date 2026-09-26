import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  createTelemetry,
  type TelemetryEvent,
  type TelemetryOptions,
} from "../../src/telemetry/index.js";

// spec/06-web-sdk.md 6.2.10, spec/05-sdk-contract.md 5.12 and spec/02-api.md 2.10.
const SDK: TelemetryOptions["sdk"] = {
  platform: "web",
  name: "@zakadi/web-core",
  version: "0.1.0",
};
const ENDPOINT = "https://api.zakadi.dev/v1/telemetry";

interface Posted {
  session_id: string;
  sdk: unknown;
  events: TelemetryEvent[];
}

let page: EventTarget;
let fetch: Mock<(url: string, init: RequestInit) => Promise<Response>>;
let sendBeacon: Mock<(url: string, body: unknown) => boolean>;

beforeEach(() => {
  vi.useFakeTimers();
  page = new EventTarget();
  fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  sendBeacon = vi.fn(() => true);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("navigator", { sendBeacon });
  vi.stubGlobal("addEventListener", page.addEventListener.bind(page));
  vi.stubGlobal("removeEventListener", page.removeEventListener.bind(page));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function start(options: Partial<TelemetryOptions> = {}) {
  const sink = vi.fn<(event: TelemetryEvent) => void>();
  const telemetry = createTelemetry({
    sessionId: "ses_01J8",
    sdk: SDK,
    sink,
    ...options,
  });
  return { telemetry, sink };
}

// The bodies fetch posted, each checked for the text/plain keepalive request of 6.2.10.
function fetched(): Posted[] {
  return fetch.mock.calls.map(([url, init]) => {
    expect(url).toBe(ENDPOINT);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "text/plain" },
      keepalive: true,
      credentials: "omit",
    });
    expect(
      new TextEncoder().encode(init.body as string).length,
    ).toBeLessThanOrEqual(32000);
    return JSON.parse(init.body as string) as Posted;
  });
}

describe("events", () => {
  it("start with sdk_start at t_ms 0 and carry t_ms since it, reaching the sink synchronously", async () => {
    const { telemetry, sink } = start();
    expect(sink).toHaveBeenCalledWith({
      name: "sdk_start",
      t_ms: 0,
      fields: {},
    });
    await vi.advanceTimersByTimeAsync(1234);
    telemetry.emit("connect", { region: "af-south-1", ms: 80 });
    expect(sink).toHaveBeenLastCalledWith({
      name: "connect",
      t_ms: 1234,
      fields: { region: "af-south-1", ms: 80 },
    });
  });

  it("keep flowing when the host's sink throws", async () => {
    const { telemetry, sink } = start();
    sink.mockImplementation(() => {
      throw new Error("host bug");
    });
    expect(() =>
      telemetry.emit("cue_missing", { cue: "greet.intro" }),
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetched()[0]?.events.map((e) => e.name)).toEqual([
      "sdk_start",
      "cue_missing",
    ]);
  });

  it("sample stats one in five, for the sink and the endpoint alike", async () => {
    const { telemetry, sink } = start();
    for (let i = 0; i < 11; i++) telemetry.emit("stats", { i });
    const sampled = [{ i: 0 }, { i: 5 }, { i: 10 }];
    expect(sink.mock.calls.slice(1).map(([event]) => event.fields)).toEqual(
      sampled,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      fetched()[0]
        ?.events.slice(1)
        .map((e) => e.fields),
    ).toEqual(sampled);
  });
});

describe("posting", () => {
  it("posts every 5 s to POST /v1/telemetry as text/plain with keepalive", async () => {
    const { telemetry } = start();
    telemetry.emit("consent_shown");
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const [body] = fetched();
    expect(body).toEqual({
      session_id: "ses_01J8",
      sdk: SDK,
      events: [
        { name: "sdk_start", t_ms: 0, fields: {} },
        { name: "consent_shown", t_ms: 0, fields: {} },
      ],
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(1);
    telemetry.emit("consent_result", { accepted: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetched()[1]?.events).toEqual([
      { name: "consent_result", t_ms: 10000, fields: { accepted: true } },
    ]);
  });

  it("sends at most 100 events per call", async () => {
    const { telemetry } = start();
    for (let i = 0; i < 249; i++)
      telemetry.emit("ui_state", { phase: "framing" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetched().map((body) => body.events.length)).toEqual([100, 100, 50]);
  });

  it("sends at most 32 KB per call and drops an event larger than that alone", async () => {
    const { telemetry } = start();
    const big = "x".repeat(10_000);
    for (let i = 0; i < 10; i++) telemetry.emit("error", { code: big, i });
    telemetry.emit("error", { code: "x".repeat(40_000) });
    await vi.advanceTimersByTimeAsync(5000);
    const bodies = fetched();
    expect(bodies.map((body) => body.events.length)).toEqual([4, 3, 3, 1]);
    expect(
      bodies.flatMap((body) => body.events).map((e) => e.fields.i ?? "start"),
    ).toEqual(["start", 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("posts what is queued with sendBeacon on pagehide", async () => {
    const { telemetry } = start();
    telemetry.emit("end", {
      outcome: "completed",
      reason: "ok",
      duration_ms: 21000,
    });
    page.dispatchEvent(new Event("pagehide"));
    expect(fetch).not.toHaveBeenCalled();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, body] = sendBeacon.mock.calls[0] ?? [];
    expect(url).toBe(ENDPOINT);
    // A string body: sendBeacon sends it as text/plain.
    expect(typeof body).toBe("string");
    expect(
      (JSON.parse(body as string) as Posted).events.map((e) => e.name),
    ).toEqual(["sdk_start", "end"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts to the configured endpoint, and nowhere when it is false", async () => {
    const custom = start({
      endpoint: "https://telemetry.example/v1/telemetry",
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://telemetry.example/v1/telemetry",
    );
    custom.telemetry.dispose();
    fetch.mockClear();
    const { telemetry, sink } = start({ endpoint: false });
    telemetry.emit("consent_shown");
    await vi.advanceTimersByTimeAsync(10_000);
    page.dispatchEvent(new Event("pagehide"));
    expect(fetch).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("posts what is left on dispose, then stops posting", async () => {
    const { telemetry, sink } = start();
    telemetry.emit("end", {
      outcome: "aborted",
      reason: "user_cancel",
      duration_ms: 900,
    });
    telemetry.dispose();
    expect(fetched()[0]?.events.map((e) => e.name)).toEqual([
      "sdk_start",
      "end",
    ]);
    telemetry.emit("error", { code: "internal" });
    await vi.advanceTimersByTimeAsync(10_000);
    page.dispatchEvent(new Event("pagehide"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledTimes(3);
  });
});
