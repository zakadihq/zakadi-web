import { afterEach, describe, expect, it, vi } from "vitest";
import { detect, pickAudio, videoSourceKind } from "../../src/detect/profile";

// The 6.2.4 candidates at the rung 0 size, as Z-044's encoder builds them.
const rung0 = { width: 480, height: 640, bitrate: 600_000, framerate: 15 };
const CANDIDATES: VideoEncoderConfig[] = [
  {
    codec: "avc1.42E01F",
    hardwareAcceleration: "prefer-hardware",
    bitrateMode: "constant",
    ...rung0,
  },
  {
    codec: "avc1.42E01F",
    hardwareAcceleration: "prefer-hardware",
    bitrateMode: "variable",
    ...rung0,
  },
  {
    codec: "avc1.42E01F",
    hardwareAcceleration: "no-preference",
    bitrateMode: "variable",
    ...rung0,
  },
  {
    codec: "vp8",
    hardwareAcceleration: "no-preference",
    bitrateMode: "variable",
    ...rung0,
  },
];
const key = (c: VideoEncoderConfig) =>
  `${c.codec}/${c.hardwareAcceleration}/${c.bitrateMode}`;

interface Runtime {
  secure?: boolean;
  camera?: boolean;
  socket?: boolean;
  /** Candidate keys VideoEncoder accepts; null: no VideoEncoder. */
  video?: readonly string[] | null;
  /** AudioEncoder's answer for mono Opus; null: no AudioEncoder. */
  opus?: boolean | null;
  /** MediaStreamTrackProcessor on the main thread. */
  mstp?: boolean;
  /** Types MediaRecorder.isTypeSupported accepts; null: no MediaRecorder. */
  recorder?: readonly string[] | null;
}

// A class with these static methods, as the browser exposes VideoEncoder and friends.
const withStatic = (statics: object) => Object.assign(class {}, statics);

function runtime(r: Runtime = {}) {
  const videoCheck = vi.fn(async (c: VideoEncoderConfig) => ({
    supported: (r.video ?? []).includes(key(c)),
    config: c,
  }));
  const typeCheck = vi.fn((t: string) => (r.recorder ?? []).includes(t));
  vi.stubGlobal("isSecureContext", r.secure ?? true);
  vi.stubGlobal("navigator", {
    mediaDevices: r.camera === false ? {} : { getUserMedia: vi.fn() },
  });
  vi.stubGlobal("WebSocket", r.socket === false ? undefined : class {});
  vi.stubGlobal(
    "VideoEncoder",
    r.video === null
      ? undefined
      : withStatic({ isConfigSupported: videoCheck }),
  );
  vi.stubGlobal("VideoFrame", r.video === null ? undefined : class {});
  vi.stubGlobal(
    "AudioEncoder",
    r.opus === null || r.opus === undefined
      ? undefined
      : withStatic({ isConfigSupported: async () => ({ supported: r.opus }) }),
  );
  vi.stubGlobal("MediaStreamTrackProcessor", r.mstp ? class {} : undefined);
  vi.stubGlobal(
    "MediaRecorder",
    r.recorder === null
      ? undefined
      : withStatic({ isTypeSupported: typeCheck }),
  );
  return { videoCheck, typeCheck };
}

const ALL_H264 = CANDIDATES.slice(0, 3).map(key);
const VP8 = key(CANDIDATES[3]!);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detect()", () => {
  it("fails internal in an insecure context", async () => {
    runtime({ secure: false, video: [...ALL_H264, VP8] });
    await expect(detect(CANDIDATES, {})).rejects.toMatchObject({
      code: "internal",
      message: "insecure_context",
    });
  });

  it.each([
    ["no getUserMedia", { camera: false }],
    ["no WebSocket", { socket: false }],
  ] as const)("fails unsupported_device with %s", async (_, r) => {
    runtime({ ...r, video: [...ALL_H264, VP8] });
    await expect(detect(CANDIDATES, {})).rejects.toMatchObject({
      code: "unsupported_device",
      message: "no_camera_api",
    });
  });

  it.each([
    ["no encoder and no recorder", { video: null, recorder: null }],
    ["no candidate accepted and no recorder type", { video: [], recorder: [] }],
  ] as const)("fails unsupported_device with %s", async (_, r) => {
    runtime(r);
    await expect(detect(CANDIDATES, {})).rejects.toMatchObject({
      code: "unsupported_device",
      message: "no_encoder",
    });
  });

  it("returns webcodecs with the first accepted candidate, both codecs checked", async () => {
    const { videoCheck } = runtime({
      video: [key(CANDIDATES[1]!), VP8],
      opus: true,
      mstp: true,
    });
    await expect(detect(CANDIDATES, {})).resolves.toEqual({
      profile: "webcodecs",
      video: CANDIDATES[1],
      supported: { "avc1.42E01F": true, vp8: true },
      hw: true,
      audio: "webcodecs-mstp",
    });
    expect(videoCheck.mock.calls.map(([c]) => c)).toEqual(CANDIDATES);
  });

  it("reports no hardware encoder when only a no-preference candidate passes", async () => {
    runtime({ video: [key(CANDIDATES[2]!)], opus: true, mstp: true });
    await expect(detect(CANDIDATES, {})).resolves.toMatchObject({
      video: CANDIDATES[2],
      supported: { "avc1.42E01F": true, vp8: false },
      hw: false,
    });
  });

  it("falls to VP8 when no H.264 candidate passes", async () => {
    runtime({ video: [VP8], opus: true, mstp: true });
    await expect(detect(CANDIDATES, {})).resolves.toMatchObject({
      video: CANDIDATES[3],
      supported: { "avc1.42E01F": false, vp8: true },
      hw: false,
    });
  });

  it("treats a rejected isConfigSupported as not supported", async () => {
    const { videoCheck } = runtime({ video: [VP8], opus: true, mstp: true });
    videoCheck.mockImplementationOnce(async () => {
      throw new TypeError("bad config");
    });
    await expect(detect(CANDIDATES, {})).resolves.toMatchObject({
      video: CANDIDATES[3],
    });
  });

  it("uses mediarecorder when a quirk forces it (6.3, 5.5)", async () => {
    const { videoCheck } = runtime({
      video: [...ALL_H264, VP8],
      opus: true,
      recorder: ["video/webm;codecs=vp8,opus"],
    });
    await expect(
      detect(CANDIDATES, { profile: "mediarecorder" }),
    ).resolves.toEqual({
      profile: "mediarecorder",
      mime: "video/webm;codecs=vp8,opus",
    });
    expect(videoCheck).not.toHaveBeenCalled();
  });

  it("takes the first recorder type in 6.3 order", async () => {
    runtime({
      video: null,
      recorder: [
        "video/mp4",
        "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
        "video/webm",
      ],
    });
    await expect(detect(CANDIDATES, {})).resolves.toEqual({
      profile: "mediarecorder",
      mime: "video/webm",
    });
  });

  it("uses the recorder when WebCodecs accepts no candidate", async () => {
    runtime({ video: [], recorder: ["video/mp4"] });
    await expect(detect(CANDIDATES, {})).resolves.toEqual({
      profile: "mediarecorder",
      mime: "video/mp4",
    });
  });

  it("asks nothing that needs a permission", async () => {
    runtime({ video: [...ALL_H264, VP8], opus: true, mstp: true });
    await detect(CANDIDATES, {});
    const media = navigator.mediaDevices as unknown as {
      getUserMedia: ReturnType<typeof vi.fn>;
    };
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });
});

describe("pickAudio()", () => {
  it.each([
    ["webcodecs-mstp", { opus: true, mstp: true, recorder: ["audio/mp4"] }],
    ["webcodecs-worklet", { opus: true, recorder: ["audio/mp4"] }],
    [
      "recorder-opus",
      { opus: false, recorder: ["audio/webm;codecs=opus", "audio/mp4"] },
    ],
    ["recorder-opus", { recorder: ["audio/webm;codecs=opus"] }],
    ["recorder-aac", { recorder: ["audio/mp4"] }],
    ["none", { recorder: [] }],
    ["none", { recorder: null }],
  ] as const)("returns %s in 6.3 order for %j", async (path, r) => {
    runtime(r);
    await expect(pickAudio()).resolves.toBe(path);
  });
});

describe("videoSourceKind()", () => {
  it.each([
    [true, false, "readable"],
    [true, true, "readable"],
    [false, true, "track"],
    [false, false, "frames"],
  ] as const)(
    "main-thread MSTP %s, engine MSTP %s: %s",
    (mainMstp, engineMstp, kind) => {
      runtime({ mstp: mainMstp });
      expect(videoSourceKind(engineMstp)).toBe(kind);
    },
  );
});

// The runtimes of the 6.3 table, by the features they expose; `engine` is the
// engine worker's MSTP (engine-ready caps.mstp).
describe("the 6.3 browser matrix", () => {
  const H264_HW = [key(CANDIDATES[0]!), key(CANDIDATES[1]!)];
  it.each([
    [
      "Chrome Android 94+, Samsung Internet, Android WebView",
      {
        video: [...H264_HW, VP8],
        opus: true,
        mstp: true,
        recorder: ["video/webm"],
      },
      false,
      { profile: "webcodecs", audio: "webcodecs-mstp", hw: true },
      "readable",
    ],
    [
      "Chromium without a hardware H.264 encoder",
      { video: [VP8], opus: true, mstp: true, recorder: ["video/webm"] },
      false,
      {
        profile: "webcodecs",
        audio: "webcodecs-mstp",
        hw: false,
        video: CANDIDATES[3],
      },
      "readable",
    ],
    [
      "Safari iOS 16.4-17.x",
      { video: [...ALL_H264], recorder: ["audio/mp4", "video/mp4"] },
      false,
      { profile: "webcodecs", audio: "recorder-aac" },
      "frames",
    ],
    [
      "Safari iOS 18.0-18.3",
      { video: [...ALL_H264], recorder: ["audio/mp4", "video/mp4"] },
      true,
      { profile: "webcodecs", audio: "recorder-aac" },
      "track",
    ],
    [
      "Safari iOS 18.4-25.x",
      {
        video: [...ALL_H264],
        recorder: ["audio/webm;codecs=opus", "audio/mp4", "video/mp4"],
      },
      true,
      { profile: "webcodecs", audio: "recorder-opus" },
      "track",
    ],
    [
      "Safari iOS 26+",
      {
        video: [...ALL_H264],
        opus: true,
        recorder: ["audio/mp4", "video/mp4"],
      },
      true,
      { profile: "webcodecs", audio: "webcodecs-worklet" },
      "track",
    ],
    [
      "Firefox Android and KaiOS 3.x",
      { video: null, recorder: ["video/webm;codecs=vp8,opus", "video/webm"] },
      false,
      { profile: "mediarecorder", mime: "video/webm;codecs=vp8,opus" },
      "frames",
    ],
    [
      "Safari iOS 14.5-16.3",
      { video: null, recorder: ["video/mp4", "audio/mp4"] },
      false,
      { profile: "mediarecorder", mime: "video/mp4" },
      "frames",
    ],
  ] as const)("%s", async (_, r, engine, expected, kind) => {
    runtime(r);
    await expect(detect(CANDIDATES, {})).resolves.toMatchObject(expected);
    expect(videoSourceKind(engine)).toBe(kind);
  });

  it("KaiOS 2.5 and Opera Mini, without getUserMedia, fail unsupported_device", async () => {
    runtime({ camera: false, video: null, recorder: null });
    await expect(detect(CANDIDATES, {})).rejects.toMatchObject({
      code: "unsupported_device",
    });
  });
});
