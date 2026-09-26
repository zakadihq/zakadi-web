import { afterEach, describe, expect, it, vi } from "vitest";
import { serve, setup, teardown, toActive, toSocket, until } from "./harness";

// The events of spec/05-sdk-contract.md 5.11: their order and payloads, `phase` as an
// open value set, and `closed` exactly once, after release or 30 s.
afterEach(teardown);

const END = { t: "end", outcome: "completed", reason: "ok", retry: false };

describe("the events of a completed call", () => {
  it("follow 5.11 in order, and closed comes once, 30 s after the end", async () => {
    const h = await setup();
    await toActive(h);
    serve(h, { t: "ui", state: { phase: "framing" } });
    serve(h, { t: "ui", state: { phase: "framing" } });
    serve(h, { t: "ui", state: { phase: "stretching" } });
    serve(h, END);
    h.sock().serverClose(1000);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events.filter((e) => e.type !== "state_changed")).toEqual([
      {
        type: "consent_given",
        record: expect.objectContaining({ lang: "en-NG" }),
      },
      { type: "permission", camera: true, microphone: true },
      // rtt_ms: the warm /v1/probe sample of the region that opened (G8).
      { type: "connected", region: "eu-west-2", rtt_ms: 0 },
      { type: "active" },
      { type: "phase", phase: "framing" },
      // An unknown phase passes through (5.11).
      { type: "phase", phase: "stretching" },
      { type: "ended", outcome: "completed", reason: "ok" },
      { type: "disconnected", close_code: 1000 },
    ]);
    expect(h.session.state).toBe("ended");
    // The camera stops with the call; the rest waits for the dismissal or 30 s.
    expect(h.video.readyState).toBe("ended");
    await vi.advanceTimersByTimeAsync(29980);
    expect(h.types()).not.toContain("closed");
    await vi.advanceTimersByTimeAsync(20);
    expect(h.types().filter((t) => t === "closed")).toHaveLength(1);
    expect(h.ctx()!.state).toBe("closed");
    h.session.dispose();
    expect(h.types().filter((t) => t === "closed")).toHaveLength(1);
  });

  it("closed comes at once when the terminal screen is dismissed", async () => {
    const h = await setup({ headless: false });
    await toActive(h);
    serve(h, END);
    await vi.advanceTimersByTimeAsync(10);
    const bridge = h.renderer!.bridge!;
    expect(bridge.view()).toMatchObject({ screen: "completed", redial: false });
    bridge.close();
    expect(h.types().at(-1)).toBe("closed");
    expect(h.renderer!.bridge).toBeNull();
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.types().filter((t) => t === "closed")).toHaveLength(1);
  });

  it("redial_requested when the terminal screen's redial is pressed", async () => {
    const h = await setup({ headless: false });
    await toSocket(h);
    h.sock().open();
    h.sock().fail();
    await until(() => h.session.state === "error");
    const bridge = h.renderer!.bridge!;
    expect(bridge.view()).toMatchObject({
      screen: "disconnected",
      redial: true,
    });
    bridge.redial();
    expect(h.types().at(-1)).toBe("redial_requested");
  });
});

describe("dispose() during the call", () => {
  it("ends it: attest, bye unknown, close 1000, then error cancelled and closed", async () => {
    const h = await setup();
    await toActive(h);
    h.session.dispose();
    await vi.advanceTimersByTimeAsync(10);
    const t = h.sock().texts();
    expect(t.slice(-2).map((m) => m.t)).toEqual(["attest", "bye"]);
    expect(t.at(-1)).toEqual({
      t: "bye",
      reason: "unknown",
      detail: "dispose",
    });
    expect(h.sock().closedWith).toEqual({ code: 1000 });
    expect(h.events.filter((e) => e.type === "error")).toEqual([
      {
        type: "error",
        code: "cancelled",
        message: "dispose",
        recoverable: true,
      },
    ]);
    expect(h.types().filter((t) => t === "closed")).toHaveLength(1);
    expect(h.pipeline().stopped).toBe(true);
  });
});

describe("handlers", () => {
  it("a throwing handler does not stop the session; on() returns the unsubscribe", async () => {
    const h = await setup();
    h.session.on("permission", () => {
      throw new Error("host bug");
    });
    const seen: string[] = [];
    const off = h.session.on("state_changed", (e) => seen.push(e.to));
    await toActive(h);
    off();
    serve(h, END);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual(["consent", "permission", "connecting", "active"]);
    expect(h.session.state).toBe("ended");
  });
});
