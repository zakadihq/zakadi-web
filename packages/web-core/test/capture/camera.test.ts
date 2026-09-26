import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_CONSTRAINTS,
  applyExposure,
  attachPreview,
  closeCamera,
  mediaErrorCode,
  openCamera,
  type Camera,
} from "../../src/capture/camera";
import {
  FakeStream,
  FakeTrack,
  fakeGetUserMedia,
  installMedia,
  mediaError,
} from "./fakes";

// The 6.2.3 video constraints.
const VIDEO = {
  facingMode: "user",
  width: { ideal: 480 },
  height: { ideal: 640 },
  frameRate: { ideal: 30 },
};

const camera = (settings: MediaTrackSettings = { facingMode: "user" }) =>
  new FakeTrack({ settings });
const mic = () => new FakeTrack({ kind: "audio" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openCamera()", () => {
  it("calls getUserMedia once with the 6.2.3 constraints and sets the audio session", async () => {
    const video = camera();
    const audio = mic();
    const getUserMedia = fakeGetUserMedia([video, audio]);
    const audioSession = { type: "auto" };
    installMedia({ getUserMedia }, { audioSession });

    const opened = await openCamera();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: VIDEO,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 16000 },
      },
    });
    expect(AUDIO_CONSTRAINTS).toEqual(getUserMedia.mock.calls[0]![0].audio);
    expect(audioSession.type).toBe("play-and-record");
    expect(opened.video).toBe(video);
    expect(opened.audio).toBe(audio);
    expect(opened.stream.getTracks()).toEqual([video, audio]);
    expect(opened.constraints).toEqual(VIDEO);
  });

  it("works where navigator has no audioSession", async () => {
    installMedia({ getUserMedia: fakeGetUserMedia([camera(), mic()]) });
    await expect(openCamera()).resolves.toBeDefined();
  });

  it.each([
    [12, 12],
    [24, 24],
    [60, 30],
  ])("caps the frame rate at max_fps %i", async (maxFps, ideal) => {
    const getUserMedia = fakeGetUserMedia([camera(), mic()]);
    installMedia({ getUserMedia });
    const opened = await openCamera({ max_fps: maxFps });
    const video = getUserMedia.mock.calls[0]![0].video;
    expect(video).toEqual({ ...VIDEO, frameRate: { ideal } });
    expect(opened.constraints.frameRate).toEqual({ ideal });
  });

  it("accepts a camera that reports no facingMode", async () => {
    const video = camera({});
    const getUserMedia = fakeGetUserMedia([video, mic()]);
    installMedia({ getUserMedia });
    await expect(openCamera()).resolves.toMatchObject({ video });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("retries an environment camera with a user one, keeping the microphone", async () => {
    const back = camera({ facingMode: "environment" });
    const front = camera({ facingMode: "user" });
    const audio = mic();
    const getUserMedia = fakeGetUserMedia([back, audio], [front]);
    installMedia({ getUserMedia });

    const opened = await openCamera({ max_fps: 15 });

    expect(back.readyState).toBe("ended");
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1]![0]).toEqual({
      video: {
        ...VIDEO,
        facingMode: { exact: "user" },
        frameRate: { ideal: 15 },
      },
    });
    expect(opened.video).toBe(front);
    expect(opened.audio).toBe(audio);
    expect(audio.readyState).toBe("live");
    expect(opened.stream.getTracks()).toEqual([front, audio]);
    expect(opened.constraints.facingMode).toEqual({ exact: "user" });
  });

  it.each([
    ["no user camera is found", mediaError("OverconstrainedError")],
    ["the device lists none", mediaError("NotFoundError")],
  ])(
    "fails unsupported_device when %s, stopping every track",
    async (_, error) => {
      const back = camera({ facingMode: "environment" });
      const audio = mic();
      installMedia({ getUserMedia: fakeGetUserMedia([back, audio], error) });
      await expect(openCamera()).rejects.toMatchObject({
        code: "unsupported_device",
      });
      expect([back.readyState, audio.readyState]).toEqual(["ended", "ended"]);
    },
  );

  it("fails unsupported_device when the retry gives another environment camera", async () => {
    const back = camera({ facingMode: "environment" });
    const other = camera({ facingMode: "environment" });
    const audio = mic();
    installMedia({ getUserMedia: fakeGetUserMedia([back, audio], [other]) });
    await expect(openCamera()).rejects.toMatchObject({
      code: "unsupported_device",
      message: "no_front_camera",
    });
    expect([other.readyState, audio.readyState]).toEqual(["ended", "ended"]);
  });

  it.each([
    ["NotAllowedError", "permission_denied"],
    ["NotFoundError", "unsupported_device"],
    ["NotReadableError", "capture_error"],
    ["AbortError", "capture_error"],
  ])("maps %s to %s (6.10)", async (name, code) => {
    installMedia({ getUserMedia: fakeGetUserMedia(mediaError(name)) });
    await expect(openCamera()).rejects.toMatchObject({ code, message: name });
    expect(mediaErrorCode(mediaError(name))).toBe(code);
  });

  it.each([
    ["OverconstrainedError", "unsupported_device"],
    ["SecurityError", "capture_error"],
    ["TypeError", "capture_error"],
  ])("maps %s to %s", (name, code) => {
    expect(mediaErrorCode(mediaError(name))).toBe(code);
  });
});

const opened = (video: FakeTrack, audio = mic()): Camera => {
  const stream = new FakeStream([video, audio]) as unknown as MediaStream;
  return {
    stream,
    video: video as unknown as MediaStreamVideoTrack,
    audio: audio as unknown as MediaStreamAudioTrack,
    constraints: { ...VIDEO },
    stops: [],
  };
};

describe("attachPreview()", () => {
  it("plays the original stream muted and inline", () => {
    const cam = opened(camera());
    const preview = {} as HTMLVideoElement;
    attachPreview(preview, cam);
    expect(preview).toMatchObject({
      srcObject: cam.stream,
      muted: true,
      playsInline: true,
      autoplay: true,
    });
  });
});

describe("applyExposure()", () => {
  const withCaps = (capabilities: Record<string, unknown> | undefined) =>
    new FakeTrack({ capabilities, settings: { facingMode: "user" } });

  it("meters the oval centre at +0.3 EV where the capabilities list both", async () => {
    const video = withCaps({
      exposureMode: ["manual", "single-shot", "continuous"],
      exposureCompensation: { min: -2, max: 2, step: 0.1666 },
    });
    await applyExposure(opened(video));
    expect(video.applied).toEqual([
      {
        ...VIDEO,
        advanced: [
          {
            exposureMode: "continuous",
            pointsOfInterest: [{ x: 0.5, y: 0.45 }],
            exposureCompensation: 0.3,
          },
        ],
      },
    ]);
  });

  it.each([
    [{ min: -0.2, max: 0.2 }, 0.2],
    [{ min: 0.5, max: 3 }, 0.5],
  ])("clamps +0.3 EV to the range %j", async (range, ev) => {
    const video = withCaps({ exposureCompensation: range });
    await applyExposure(opened(video));
    expect(video.applied).toEqual([
      { ...VIDEO, advanced: [{ exposureCompensation: ev }] },
    ]);
  });

  it("sets the metering alone where only the exposure mode is listed", async () => {
    const video = withCaps({ exposureMode: ["continuous"] });
    await applyExposure(opened(video));
    expect(video.applied[0]!.advanced).toEqual([
      { exposureMode: "continuous", pointsOfInterest: [{ x: 0.5, y: 0.45 }] },
    ]);
  });

  it.each([
    ["no exposure capability", { width: { min: 1, max: 1280 } }],
    ["no continuous mode", { exposureMode: ["manual"] }],
    ["no getCapabilities", undefined],
  ])("requests nothing with %s", async (_, capabilities) => {
    const video = withCaps(capabilities);
    await applyExposure(opened(video));
    expect(video.applied).toEqual([]);
  });
});

describe("closeCamera()", () => {
  it("stops the original tracks and runs every recorded stop", () => {
    const video = camera();
    const audio = mic();
    const cam = opened(video, audio);
    const clone = video.clone();
    cam.stops.push(() => clone.stop());
    closeCamera(cam);
    expect([video, audio, clone].map((t) => t.readyState)).toEqual([
      "ended",
      "ended",
      "ended",
    ]);
    expect(cam.stops).toEqual([]);
  });
});
