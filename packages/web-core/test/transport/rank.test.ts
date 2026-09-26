import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rankIngest } from "../../src/transport/rank";

// Region ranking (spec/05-sdk-contract.md 5.15, spec/06-web-sdk.md 6.2.6 and 6.2.10).
const cand = (region: string) => ({
  region,
  url: `wss://ingest-${region}.zakadi.dev/v1/sessions/ses_01J8VECTOR000000000001/stream`,
});

type Answer = number | "fail" | "hang";

/** Each host answers its requests in turn: after a delay in ms, with a network error, or never. */
function serve(plan: Record<string, Answer[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const answer = plan[new URL(url).hostname.split(".")[0]!]!.shift();
    return new Promise((resolve, reject) => {
      if (answer === "fail") reject(new TypeError("network"));
      else if (answer === "hang")
        init.signal!.addEventListener("abort", () =>
          reject(new Error("abort")),
        );
      else
        setTimeout(() => resolve(new Response(null, { status: 204 })), answer);
    });
  });
  return calls;
}

describe("rankIngest()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ranks on the first (cold) sample, keeps ties in list order and the warm sample", async () => {
    serve({
      "ingest-a": [300, 10],
      "ingest-b": [100, 200],
      "ingest-c": [100, 50],
    });
    const p = rankIngest([cand("a"), cand("b"), cand("c")]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual([
      { ...cand("b"), warmMs: 200 },
      { ...cand("c"), warmMs: 50 },
      { ...cand("a"), warmMs: 10 },
    ]);
  });

  it("probes GET /v1/probe on the https origin, twice, without cookies or cache", async () => {
    const calls = serve({ "ingest-a": [5, 5] });
    const p = rankIngest([cand("a")]);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(calls.map((c) => c.url)).toEqual([
      "https://ingest-a.zakadi.dev/v1/probe",
      "https://ingest-a.zakadi.dev/v1/probe",
    ]);
    expect(calls[0]!.init).toMatchObject({
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
    });
  });

  it("skips a candidate whose request fails or passes 2 s", async () => {
    const calls = serve({
      "ingest-a": ["fail"],
      "ingest-b": [2001],
      "ingest-c": [100, "hang"],
      "ingest-d": [1999, 1999],
    });
    const p = rankIngest([cand("a"), cand("b"), cand("c"), cand("d")]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toEqual([{ ...cand("d"), warmMs: 1999 }]);
    const hung = calls.filter((c) => c.url.includes("ingest-c"))[1]!;
    expect(hung.init.signal!.aborted).toBe(true);
  });

  it("returns the list in its own order when every candidate fails", async () => {
    serve({ "ingest-a": ["fail"], "ingest-b": ["hang"] });
    const list = [cand("a"), cand("b")];
    const p = rankIngest(list);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe(list);
  });
});
