import type { UiEventMsg } from "@zakadi/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UA } from "../audio/fakes";
import {
  begin,
  serve,
  setup,
  teardown,
  toActive,
  until,
  type Harness,
} from "./harness";

// The rows of spec/06-web-sdk.md 6.8 (spec/05-sdk-contract.md 5.14): each detection and
// the action it produces.
afterEach(teardown);

const uiEvents = (h: Harness) =>
  h
    .sock()
    .texts()
    .filter((m): m is UiEventMsg => m.t === "ui_event")
    .map((m) => m.event);
const tail = (h: Harness, n: number) =>
  h
    .sock()
    .texts()
    .slice(-n)
    .map((m) => (m.t === "bye" ? `bye ${m.reason}` : m.t));
const hide = (h: Harness, hidden: boolean) => {
  h.doc.visibilityState = hidden ? "hidden" : "visible";
  h.doc.dispatchEvent(new Event("visibilitychange"));
};

describe("tab hidden, app switch, lock", () => {
  it("app_backgrounded; visible again within 2 s: app_foregrounded, and the call goes on", async () => {
    const h = await setup();
    await toActive(h);
    hide(h, true);
    await vi.advanceTimersByTimeAsync(1500);
    hide(h, false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(uiEvents(h)).toEqual(["app_backgrounded", "app_foregrounded"]);
    expect(h.session.state).toBe("active");
  });

  it("still hidden after 2 s: attest, bye app_background, capture stops, interrupted", async () => {
    const h = await setup();
    await toActive(h);
    hide(h, true);
    await vi.advanceTimersByTimeAsync(1990);
    expect(h.session.state).toBe("active");
    await vi.advanceTimersByTimeAsync(20);
    expect(tail(h, 2)).toEqual(["attest", "bye app_background"]);
    expect(h.events.filter((e) => e.type === "error")).toEqual([
      expect.objectContaining({ code: "interrupted", recoverable: true }),
    ]);
    expect(h.video.readyState).toBe("ended");
    expect(h.pipeline().stopped).toBe(true);
    // No resume after bye.
    hide(h, false);
    await vi.advanceTimersByTimeAsync(10);
    expect(uiEvents(h)).toEqual(["app_backgrounded"]);
  });

  it("iOS: back after a freeze longer than 2 s that held the timer: interrupted", async () => {
    const h = await setup();
    await toActive(h);
    hide(h, true);
    // The page was frozen: the wall clock moved on, the timer did not fire.
    vi.setSystemTime(Date.now() + 5000);
    hide(h, false);
    await vi.advanceTimersByTimeAsync(10);
    expect(uiEvents(h)).toEqual(["app_backgrounded"]);
    expect(h.events.at(-1)).toMatchObject({
      type: "error",
      code: "interrupted",
    });
  });
});

describe("navigation, bfcache", () => {
  it("pagehide: attest, bye app_background pagehide, close 1000, beacon, tracks stopped", async () => {
    const h = await setup({
      config: { telemetryEndpoint: "https://api.zakadi.test/v1/telemetry" },
      nav: { sendBeacon: vi.fn(() => true) },
    });
    await toActive(h);
    h.page.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.sock().texts().at(-1)).toEqual({
      t: "bye",
      reason: "app_background",
      detail: "pagehide",
    });
    expect(tail(h, 2)[0]).toBe("attest");
    expect(h.sock().closedWith).toEqual({ code: 1000 });
    expect(
      (navigator as unknown as { sendBeacon: ReturnType<typeof vi.fn> })
        .sendBeacon,
    ).toHaveBeenCalled();
    expect(h.video.readyState).toBe("ended");
    expect(h.types().slice(-2)).toEqual(["error", "closed"]);
  });
});

describe("incoming call, audio interruption", () => {
  it("a camera muted for over 2 s: interrupted", async () => {
    const h = await setup();
    await toActive(h);
    h.video.fire("mute");
    await vi.advanceTimersByTimeAsync(1000);
    h.video.fire("unmute");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.session.state).toBe("active");
    h.video.fire("mute");
    await vi.advanceTimersByTimeAsync(2010);
    expect(tail(h, 1)).toEqual(["bye app_background"]);
    expect(h.events.at(-1)).toMatchObject({
      type: "error",
      code: "interrupted",
    });
  });

  it("an AudioContext interrupted for over 2 s: interrupted", async () => {
    const h = await setup();
    await toActive(h);
    h.ctx()!.become("interrupted");
    await vi.advanceTimersByTimeAsync(2010);
    expect(h.events.at(-1)).toMatchObject({
      type: "error",
      code: "interrupted",
    });
  });
});

describe("the AudioContext stops briefly", () => {
  it("a say fails with audio_state failed, and the next tap resumes the context", async () => {
    const h = await setup();
    await toActive(h);
    const ctx = h.ctx()!;
    ctx.become("suspended");
    serve(h, { t: "say", id: "s4", cue: "greet.short" });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.sock().texts().at(-1)).toMatchObject({
      t: "audio_state",
      re: "s4",
      event: "failed",
    });
    const resumes = ctx.log.filter((x) => x === "resume").length;
    h.doc.dispatchEvent(new Event("pointerdown"));
    expect(ctx.log.filter((x) => x === "resume").length).toBe(resumes + 1);
    expect(ctx.state).toBe("running");
    expect(h.session.state).toBe("active");
  });
});

describe("device change", () => {
  it("a headset connecting or leaving: ui_event headphones_changed", async () => {
    const h = await setup();
    await toActive(h);
    const device = (kind: MediaDeviceKind, label: string) =>
      ({ kind, label, deviceId: label, groupId: "g" }) as MediaDeviceInfo;
    h.media.enumerateDevices.mockResolvedValue([
      device("audiooutput", "Wired headset"),
    ]);
    h.media.dispatchEvent(new Event("devicechange"));
    await vi.advanceTimersByTimeAsync(10);
    h.media.enumerateDevices.mockResolvedValue([
      device("audiooutput", "Speaker"),
    ]);
    h.media.dispatchEvent(new Event("devicechange"));
    await vi.advanceTimersByTimeAsync(10);
    const sent = h
      .sock()
      .texts()
      .filter((m): m is UiEventMsg => m.t === "ui_event");
    expect(sent.map((m) => m.detail)).toEqual([
      { connected: true },
      { connected: false },
    ]);
  });
});

describe("track ended", () => {
  it("with the camera permission denied: bye permission_revoked, permission_denied", async () => {
    const h = await setup();
    await toActive(h);
    h.permission.state = "denied";
    h.video.fire("ended");
    await vi.advanceTimersByTimeAsync(10);
    expect(tail(h, 1)).toEqual(["bye permission_revoked"]);
    expect(h.events.at(-1)).toMatchObject({ code: "permission_denied" });
  });

  it("otherwise: bye capture_error, capture_error", async () => {
    const h = await setup();
    await toActive(h);
    h.video.fire("ended");
    await vi.advanceTimersByTimeAsync(10);
    expect(tail(h, 1)).toEqual(["bye capture_error"]);
    expect(h.events.at(-1)).toMatchObject({ code: "capture_error" });
  });
});

describe("the encoder is reclaimed or fails", () => {
  it("bye encoder_error, encoder_error", async () => {
    const h = await setup();
    await toActive(h);
    h.pipeline().fail("encoder_error");
    await vi.advanceTimersByTimeAsync(10);
    expect(tail(h, 1)).toEqual(["bye encoder_error"]);
    expect(h.events.at(-1)).toMatchObject({ code: "encoder_error" });
  });
});

describe("orientation", () => {
  it("Android: fullscreen on the consent tap, then the portrait lock", async () => {
    const lock = vi.fn(async () => undefined);
    vi.stubGlobal("screen", { orientation: { lock } });
    const h = await setup({ headless: false });
    begin(h);
    await until(() => h.types().includes("permission"));
    // The call element goes fullscreen, inside the tap.
    expect(h.renderer!.requestFullscreen).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(lock).toHaveBeenCalledWith("portrait");
    expect(h.telemetryNames()).not.toContain("orientation_unlocked");
  });

  it("no lock (iOS), or a lock that fails: orientation_unlocked", async () => {
    vi.stubGlobal("screen", {});
    const h = await setup({ userAgent: UA.safari });
    begin(h);
    await until(() => h.types().includes("permission"));
    expect(h.telemetryNames()).toContain("orientation_unlocked");

    teardown();
    vi.stubGlobal("screen", {
      orientation: { lock: vi.fn(async () => Promise.reject(new Error("no"))) },
    });
    const g = await setup({ headless: false });
    begin(g);
    await until(() => g.types().includes("permission"));
    await vi.advanceTimersByTimeAsync(0);
    expect(g.telemetryNames()).toContain("orientation_unlocked");
  });
});

describe("screen dimming", () => {
  it("a screen wake lock while active, released with the call", async () => {
    const h = await setup();
    await toActive(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.wakeLocks).toHaveLength(1);
    expect(h.wakeLocks[0]!.released).toBe(false);
    serve(h, { t: "end", outcome: "completed", reason: "ok", retry: false });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.wakeLocks[0]!.released).toBe(true);
  });
});
