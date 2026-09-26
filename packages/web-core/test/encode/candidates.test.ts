import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANDIDATES,
  audioConfig,
  check,
  order,
  videoConfig,
} from "../../src/encode/index.js";
import { FakeVideoEncoder, installFakes, removeFakes } from "./fakes.js";
import { LADDER, at, camera, started } from "./harness.js";

// spec/06-web-sdk.md 6.2.4: the candidates, their order and what the checks report.
beforeEach(installFakes);
afterEach(removeFakes);

const H264 = "avc1.42E01F";
const RUNG0 = LADDER.slice(0, 1);
const hwCbr = (c: VideoEncoderConfig) =>
  c.hardwareAcceleration === "prefer-hardware" && c.bitrateMode === "constant";

describe("the 6.2.4 candidates", () => {
  it("go hardware CBR, hardware VBR, no-preference H.264, then VP8", () => {
    expect(order().map((c) => [c.codec, c.hw, c.bitrateMode])).toEqual([
      [H264, "prefer-hardware", "constant"],
      [H264, "prefer-hardware", "variable"],
      [H264, "no-preference", "variable"],
      ["vp8", "no-preference", "variable"],
    ]);
    expect(order()).toEqual(CANDIDATES);
  });

  it("put the no-preference H.264 candidate first under prefer_software_encoder (D94)", () => {
    expect(order(true)).toEqual([
      CANDIDATES[2],
      CANDIDATES[0],
      CANDIDATES[1],
      CANDIDATES[3],
    ]);
  });

  it("configure the rung's size, bitrate and rate in realtime mode, Annex-B for H.264", () => {
    expect(videoConfig(LADDER[3]!, CANDIDATES[0]!)).toEqual({
      codec: H264,
      width: 336,
      height: 448,
      bitrate: 250_000,
      framerate: 12,
      hardwareAcceleration: "prefer-hardware",
      bitrateMode: "constant",
      latencyMode: "realtime",
      avc: { format: "annexb" },
    });
    expect(videoConfig(LADDER[0]!, CANDIDATES[3]!, 1200)).not.toHaveProperty(
      "avc",
    );
    expect(videoConfig(LADDER[0]!, CANDIDATES[3]!, 1200).bitrate).toBe(
      1_200_000,
    );
    expect(audioConfig(48000, 16)).toEqual({
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: 16_000,
      bitrateMode: "constant",
      opus: {
        format: "opus",
        frameDuration: 20000,
        useinbandfec: false,
        usedtx: false,
      },
    });
  });
});

describe("check()", () => {
  it("checks both codecs even when hardware H.264 passes, and reports hardware", async () => {
    const r = await check(RUNG0);
    expect(r.ok).toEqual(CANDIDATES);
    expect(r.encoder).toEqual({
      impl: "hardware",
      is_config_supported: { [H264]: true, vp8: true },
    });
    expect(FakeVideoEncoder.checked.map((c) => c.codec)).toContain("vp8");
    expect(r.diff).toEqual([]);
  });

  it("falls through to VP8 when no H.264 configuration is supported", async () => {
    FakeVideoEncoder.supported = (c) => c.codec === "vp8";
    const r = await check(RUNG0);
    expect(r.ok).toEqual([CANDIDATES[3]]);
    expect(r.encoder).toEqual({
      impl: "unknown",
      is_config_supported: { [H264]: false, vp8: true },
    });
  });

  it("reports unknown unless the accepted candidate prefers hardware", async () => {
    FakeVideoEncoder.supported = (c) =>
      c.hardwareAcceleration === "no-preference";
    expect((await check(RUNG0)).encoder.impl).toBe("unknown");
    FakeVideoEncoder.supported = () => true;
    expect((await check(RUNG0, true)).encoder.impl).toBe("unknown");
    FakeVideoEncoder.supported = (c) =>
      c.hardwareAcceleration === "prefer-hardware" || c.codec === "vp8";
    const r = await check(RUNG0, true);
    expect(r.ok[0]).toBe(CANDIDATES[0]);
    expect(r.encoder.impl).toBe("hardware");
  });

  it("accepts a candidate only if every rung given is supported", async () => {
    FakeVideoEncoder.supported = (c) => !(hwCbr(c) && c.width === 288);
    const r = await check(LADDER);
    expect(r.ok[0]).toBe(CANDIDATES[1]);
    expect(r.encoder.impl).toBe("hardware");
  });

  it("treats a rejected check as unsupported and lists what the UA did not echo", async () => {
    const real = FakeVideoEncoder.isConfigSupported;
    FakeVideoEncoder.isConfigSupported = async (config) => {
      if (hwCbr(config)) throw new TypeError("bad config");
      const echo = { ...config };
      delete echo.latencyMode;
      return { supported: true, config: echo };
    };
    try {
      const r = await check(RUNG0);
      expect(r.ok[0]).toBe(CANDIDATES[1]);
      expect(r.diff).toEqual(["latencyMode"]);
    } finally {
      FakeVideoEncoder.isConfigSupported = real;
    }
  });
});

describe("configuring at start", () => {
  it("re-checks every rung of the ready ladder and configures the first candidate that passes", async () => {
    FakeVideoEncoder.supported = (c) =>
      c.hardwareAcceleration === "no-preference";
    const run = await started();
    expect(
      FakeVideoEncoder.checked.filter((c) => c.width === 288).length,
    ).toBeGreaterThan(0);
    expect(run.enc().configs[0]).toMatchObject({
      codec: H264,
      hardwareAcceleration: "no-preference",
      width: 480,
      height: 640,
    });
  });

  it("starts with the no-preference H.264 candidate under prefer_software_encoder", async () => {
    const run = await started({ preferSoftware: true });
    expect(run.enc().configs[0]).toMatchObject({
      codec: H264,
      hardwareAcceleration: "no-preference",
    });
  });

  it("falls through to VP8, whose config carries codec vp8 and no Annex-B", async () => {
    FakeVideoEncoder.supported = (c) => c.codec === "vp8";
    const run = await started();
    run.feed(1000, 1100);
    const [first] = run.chunks("video");
    expect(first?.config?.video).toMatchObject({
      codec: "vp8",
      annexb: false,
      w: 480,
      h: 640,
      fps: 15,
    });
  });

  it("fails with encoder_error when no candidate is supported", async () => {
    FakeVideoEncoder.supported = () => false;
    const run = await started();
    at(1100);
    run.p.frame(camera(1095));
    expect(run.events).toContainEqual(
      expect.objectContaining({ k: "error", code: "encoder_error" }),
    );
    expect(run.chunks()).toEqual([]);
  });
});
