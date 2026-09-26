import { validateHelloMsg, type HelloMsg } from "@zakadi/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { a11ySettings, haptic, type A11y } from "../../src/a11y/index.js";

// spec/06-web-sdk.md 6.2.10 and spec/05-sdk-contract.md 5.10.
function prefersReducedMotion(matches: boolean) {
  const matchMedia = vi.fn((query: string) => ({ matches, media: query }));
  vi.stubGlobal("matchMedia", matchMedia);
  return matchMedia;
}

const SCREEN_READER: A11y = {
  screen_reader: true,
  captions: true,
  reduced_motion: false,
  extended_time: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a11ySettings()", () => {
  it("follows prefers-reduced-motion unless configured", () => {
    const matchMedia = prefersReducedMotion(true);
    expect(a11ySettings().reduced_motion).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(a11ySettings({ reducedMotion: false }).reduced_motion).toBe(false);
    prefersReducedMotion(false);
    expect(a11ySettings().reduced_motion).toBe(false);
    expect(a11ySettings({ reducedMotion: true }).reduced_motion).toBe(true);
  });

  it("reads no reduced motion where matchMedia is missing", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(a11ySettings().reduced_motion).toBe(false);
  });

  it("turns captions on by default", () => {
    prefersReducedMotion(false);
    expect(a11ySettings().captions).toBe(true);
    expect(a11ySettings({ captions: false }).captions).toBe(false);
  });

  it("takes screen-reader mode and extended time from configuration only", () => {
    prefersReducedMotion(false);
    expect(a11ySettings()).toEqual({
      screen_reader: false,
      captions: true,
      reduced_motion: false,
      extended_time: false,
    });
    expect(
      a11ySettings({ screenReader: true, extendedTime: true }),
    ).toMatchObject({
      screen_reader: true,
      extended_time: true,
    });
  });

  it("gives the a11y object of hello", () => {
    prefersReducedMotion(true);
    const hello: HelloMsg = {
      t: "hello",
      v: 1,
      token: "eyJ.test.token",
      sdk: { platform: "web", name: "@zakadi/web-core", version: "0.1.0" },
      caps: {
        profile: "webcodecs",
        video: ["avc1.42E01F"],
        audio: ["opus"],
        keyframe_on_demand: true,
        bitrate_reconfig: true,
      },
      prompt_pack: { lang: "fr-CI", version: "1.0.0" },
      a11y: a11ySettings({ screenReader: true }),
      consent: {
        biometric: true,
        recording: true,
        at_ms_wall: 1_790_000_000_000,
      },
    };
    expect(validateHelloMsg(hello)).toBe(true);
  });
});

describe("haptic()", () => {
  it("pulses navigator.vibrate(40) on frame.perfect in screen-reader mode", () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal("navigator", { vibrate });
    expect(haptic("frame.perfect", SCREEN_READER)).toBe(true);
    expect(vibrate).toHaveBeenCalledWith(40);
  });

  it("stays still for other cues and outside screen-reader mode", () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal("navigator", { vibrate });
    expect(haptic("frame.hold_still", SCREEN_READER)).toBe(false);
    expect(
      haptic("frame.perfect", { ...SCREEN_READER, screen_reader: false }),
    ).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("does nothing where the browser has no vibration", () => {
    vi.stubGlobal("navigator", {});
    expect(haptic("frame.perfect", SCREEN_READER)).toBe(false);
    vi.stubGlobal("navigator", {
      vibrate: () => {
        throw new TypeError("blocked");
      },
    });
    expect(haptic("frame.perfect", SCREEN_READER)).toBe(false);
    vi.stubGlobal("navigator", { vibrate: () => false });
    expect(haptic("frame.perfect", SCREEN_READER)).toBe(false);
  });
});
