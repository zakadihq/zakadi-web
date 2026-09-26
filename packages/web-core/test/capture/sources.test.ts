import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeCamera, type Camera } from "../../src/capture/camera";
import {
  audioSource,
  onFrames,
  pumpFrames,
  sendVideo,
  type AudioSource,
  type VideoSource,
} from "../../src/capture/sources";
import { FakeProcessor, FakeStream, FakeTrack, FakeVideo } from "./fakes";

function opened(withMic = true) {
  const audio = withMic ? new FakeTrack({ kind: "audio" }) : undefined;
  const video = new FakeTrack({ settings: { facingMode: "user" } });
  const tracks = audio ? [video, audio] : [video];
  const camera: Camera = {
    stream: new FakeStream(tracks) as unknown as MediaStream,
    video: video as unknown as MediaStreamVideoTrack,
    audio: audio as unknown as MediaStreamAudioTrack | undefined,
    constraints: {},
    stops: [],
  };
  return { camera, video, audio };
}

beforeEach(() => {
  FakeProcessor.instances.length = 0;
  vi.stubGlobal("MediaStreamTrackProcessor", FakeProcessor);
  vi.stubGlobal("MediaStream", FakeStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendVideo()", () => {
  it("transfers the MSTP stream of a clone, the preview keeping the original", () => {
    const { camera, video } = opened();
    const post = vi.fn<(s: VideoSource, t: Transferable[]) => void>();
    expect(sendVideo(camera, "readable", post)).toBe("readable");
    const [processor] = FakeProcessor.instances;
    expect(processor!.track.source).toBe(video);
    expect(post).toHaveBeenCalledWith(
      { kind: "readable", stream: processor!.readable },
      [processor!.readable],
    );
    expect(video.readyState).toBe("live");
    closeCamera(camera);
    expect(processor!.track.readyState).toBe("ended");
  });

  it("transfers a clone of the track", () => {
    const { camera, video } = opened();
    const post = vi.fn<(s: VideoSource, t: Transferable[]) => void>();
    expect(sendVideo(camera, "track", post)).toBe("track");
    const [clone] = video.clones;
    expect(post).toHaveBeenCalledWith({ kind: "track", track: clone }, [clone]);
    expect(clone).not.toBe(video);
  });

  it("falls back to rVFC frames when the track cannot be transferred", () => {
    const { camera, video } = opened();
    const post = vi
      .fn<(s: VideoSource, t: Transferable[]) => void>()
      .mockImplementationOnce(() => {
        throw new DOMException("MediaStreamTrack", "DataCloneError");
      });
    expect(sendVideo(camera, "track", post)).toBe("frames");
    expect(video.clones[0]!.readyState).toBe("ended");
    expect(post).toHaveBeenLastCalledWith({ kind: "frames" }, []);
    expect(video.readyState).toBe("live");
  });

  it("rethrows any other error", () => {
    const { camera } = opened();
    const post = () => {
      throw new TypeError("closed");
    };
    expect(() => sendVideo(camera, "track", post)).toThrow("closed");
  });

  it("posts frames with nothing to transfer", () => {
    const { camera, video } = opened();
    const post = vi.fn<(s: VideoSource, t: Transferable[]) => void>();
    expect(sendVideo(camera, "frames", post)).toBe("frames");
    expect(post).toHaveBeenCalledWith({ kind: "frames" }, []);
    expect(video.clones).toEqual([]);
  });
});

class StubFrame {
  closed = false;
  constructor(
    readonly source: unknown,
    readonly init: VideoFrameInit,
  ) {}
  close() {
    this.closed = true;
  }
}

describe("pumpFrames()", () => {
  it("wraps each presented frame of the preview with its capture time in microseconds", () => {
    vi.stubGlobal("VideoFrame", StubFrame);
    const preview = new FakeVideo();
    const post = vi.fn();
    const stop = pumpFrames(preview as unknown as HTMLVideoElement, post);
    preview.present({ width: 480, height: 640, captureTime: 1000.25 });
    preview.present({ width: 480, height: 640, expectedDisplayTime: 1033.5 });
    expect(post.mock.calls.map(([f]) => [f.source, f.init.timestamp])).toEqual([
      [preview, 1000250],
      [preview, 1033500],
    ]);
    stop();
    expect(preview.pending).toBe(0);
    preview.present({ width: 480, height: 640 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("closes a frame the post could not transfer and keeps pumping", () => {
    vi.stubGlobal("VideoFrame", StubFrame);
    const preview = new FakeVideo();
    const frames: StubFrame[] = [];
    pumpFrames(preview as unknown as HTMLVideoElement, (f) => {
      frames.push(f as unknown as StubFrame);
      throw new DOMException("detached", "DataCloneError");
    });
    preview.present({ width: 480, height: 640, captureTime: 5 });
    expect(frames[0]!.closed).toBe(true);
    expect(preview.pending).toBe(1);
  });

  it("skips a frame the element cannot give yet", () => {
    vi.stubGlobal("VideoFrame", function () {
      throw new DOMException("no frame", "InvalidStateError");
    });
    const preview = new FakeVideo();
    const post = vi.fn();
    pumpFrames(preview as unknown as HTMLVideoElement, post);
    preview.present({ width: 480, height: 640 });
    expect(post).not.toHaveBeenCalled();
    expect(preview.pending).toBe(1);
  });
});

describe("onFrames()", () => {
  it("passes the capture time, else the expected display time", () => {
    const video = new FakeVideo();
    const seen: number[] = [];
    onFrames(video as unknown as HTMLVideoElement, (ms, meta) =>
      seen.push(ms, meta.width),
    );
    video.present({ width: 480, height: 640, captureTime: 10 });
    video.present({ width: 240, height: 320, expectedDisplayTime: 20 });
    expect(seen).toEqual([10, 480, 20, 240]);
  });
});

class FakeNode {
  readonly connected: unknown[] = [];
  disconnected = false;
  connect<T>(next: T): T {
    this.connected.push(next);
    return next;
  }
  disconnect() {
    this.disconnected = true;
  }
}

function fakeContext() {
  const nodes: Record<string, FakeNode & Record<string, unknown>> = {};
  class WorkletNode extends FakeNode {
    readonly port = new MessageChannel().port1;
    constructor(
      readonly context: unknown,
      readonly name: string,
    ) {
      super();
      nodes.worklet = this as unknown as FakeNode & Record<string, unknown>;
    }
  }
  class Gain extends FakeNode {
    constructor(
      readonly context: unknown,
      readonly options: { gain: number },
    ) {
      super();
      nodes.gain = this as unknown as FakeNode & Record<string, unknown>;
    }
  }
  vi.stubGlobal("AudioWorkletNode", WorkletNode);
  vi.stubGlobal("GainNode", Gain);
  const destination = new FakeNode();
  const context = {
    sampleRate: 48000,
    destination,
    audioWorklet: { addModule: vi.fn(async (url: string) => void url) },
    createMediaStreamSource: vi.fn((stream: FakeStream) => {
      const node = Object.assign(new FakeNode(), { stream });
      nodes.input = node as unknown as FakeNode & Record<string, unknown>;
      return node;
    }),
  };
  return { context, nodes, destination };
}

const URL_ = "https://cdn.example/web-core/capture.worklet.js";

describe("audioSource()", () => {
  it("gives the engine none without a microphone track or an audio path", async () => {
    const { context } = fakeContext();
    const ctx = context as unknown as AudioContext;
    const noMic = opened(false);
    await expect(
      audioSource(noMic.camera, "webcodecs-mstp", ctx, URL_),
    ).resolves.toEqual({ source: { kind: "none" }, transfer: [] });
    const { camera, audio } = opened();
    await expect(audioSource(camera, "none", ctx, URL_)).resolves.toEqual({
      source: { kind: "none" },
      transfer: [],
    });
    expect(audio!.clones).toEqual([]);
  });

  it("transfers the MSTP stream of a microphone clone", async () => {
    const { context } = fakeContext();
    const { camera, audio } = opened();
    const got = await audioSource(
      camera,
      "webcodecs-mstp",
      context as unknown as AudioContext,
      URL_,
    );
    const [processor] = FakeProcessor.instances;
    expect(processor!.track.source).toBe(audio);
    expect(got).toEqual({
      source: { kind: "readable", stream: processor!.readable },
      transfer: [processor!.readable],
    });
  });

  it("feeds a microphone clone to the capture worklet and hands over its port", async () => {
    const { context, nodes, destination } = fakeContext();
    const { camera, audio } = opened();
    const got = await audioSource(
      camera,
      "webcodecs-worklet",
      context as unknown as AudioContext,
      URL_,
    );
    expect(context.audioWorklet.addModule).toHaveBeenCalledWith(URL_);
    const { worklet, gain, input } = nodes;
    expect(worklet).toMatchObject({ context, name: "zakadi-capture" });
    expect((input!.stream as FakeStream).tracks).toEqual([audio!.clones[0]]);
    expect(input!.connected).toEqual([worklet]);
    expect(worklet!.connected).toEqual([gain]);
    expect(gain!.options).toEqual({ gain: 0 });
    expect(gain!.connected).toEqual([destination]);
    expect(got).toEqual({
      source: { kind: "pcm", port: worklet!.port, sampleRate: 48000 },
      transfer: [worklet!.port],
    });
    closeCamera(camera);
    expect([input!.disconnected, worklet!.disconnected]).toEqual([true, true]);
    expect(audio!.clones[0]!.readyState).toBe("ended");
  });

  it("takes the processor name the worklet registers", async () => {
    const { context, nodes } = fakeContext();
    const { camera } = opened();
    await audioSource(
      camera,
      "webcodecs-worklet",
      context as unknown as AudioContext,
      URL_,
      "capture",
    );
    expect(nodes.worklet!.name).toBe("capture");
  });

  it.each([
    ["recorder-opus", "webm"],
    ["recorder-aac", "mp4"],
  ] as const)(
    "gives %s a channel and a microphone clone for the recorder",
    async (path, container) => {
      const { context } = fakeContext();
      const { camera, audio } = opened();
      const got = await audioSource(
        camera,
        path,
        context as unknown as AudioContext,
        URL_,
      );
      const source = got.source as Extract<AudioSource, { kind: "recorder" }>;
      expect(source).toMatchObject({ kind: "recorder", container });
      expect(got.transfer).toEqual([source.port]);
      expect(got.recorder!.track).toBe(audio!.clones[0]);
      expect(got.recorder!.port).not.toBe(source.port);
    },
  );
});
