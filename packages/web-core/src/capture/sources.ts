// spec/06-web-sdk.md 6.2.1, 6.2.3 and 6.3: the engine's video and audio inputs, made
// from clones so that a transfer never detaches the preview's original tracks.
import type { AudioPath, VideoSourceKind } from "../detect/profile";
import type { Camera } from "./camera";

/** The `video` of the engine's `init` message (6.2.1). */
export type VideoSource =
  | { kind: "readable"; stream: ReadableStream<VideoFrame> }
  | { kind: "track"; track: MediaStreamTrack }
  | { kind: "frames" };

/** The `audio` of the engine's `init` message (6.2.1). */
export type AudioSource =
  | { kind: "readable"; stream: ReadableStream<AudioData> }
  | { kind: "pcm"; port: MessagePort; sampleRate: number }
  | { kind: "recorder"; port: MessagePort; container: "mp4" | "webm" }
  | { kind: "none" };

/** Posts a source to the engine, transferring `transfer`. */
export type Post<S> = (source: S, transfer: Transferable[]) => void;

const clone = <T extends MediaStreamTrack>(camera: Camera, track: T): T => {
  const copy = track.clone() as T;
  camera.stops.push(() => copy.stop());
  return copy;
};

/**
 * Hands the engine a clone of the camera track as `kind` through `post` (6.3). A track
 * the browser cannot transfer (DataCloneError) is stopped and rVFC frames are posted
 * instead. Returns the kind the engine got; for `frames`, start pumpFrames.
 */
export function sendVideo(
  camera: Camera,
  kind: VideoSourceKind,
  post: Post<VideoSource>,
): VideoSourceKind {
  if (kind === "readable") {
    const { readable } = new MediaStreamTrackProcessor({
      track: clone(camera, camera.video),
    });
    post({ kind, stream: readable }, [readable]);
  } else if (kind === "track") {
    const track = clone(camera, camera.video);
    try {
      post({ kind, track }, [track as unknown as Transferable]);
    } catch (e) {
      if ((e as Error).name !== "DataCloneError") throw e;
      track.stop();
      return sendVideo(camera, "frames", post);
    }
  } else {
    post({ kind }, []);
  }
  return kind;
}

/**
 * Runs `cb` on every frame `video` presents (requestVideoFrameCallback), with the
 * frame's capture time in milliseconds on the performance clock, expectedDisplayTime
 * where the metadata has none. Returns the stop.
 */
export function onFrames(
  video: HTMLVideoElement,
  cb: (ms: number, meta: VideoFrameCallbackMetadata) => void,
) {
  let id = 0;
  const next: VideoFrameRequestCallback = (_, meta) => {
    cb(meta.captureTime ?? meta.expectedDisplayTime, meta);
    id = video.requestVideoFrameCallback(next);
  };
  id = video.requestVideoFrameCallback(next);
  return () => video.cancelVideoFrameCallback(id);
}

/**
 * The rVFC path (6.3): wraps each presented frame of the preview in a VideoFrame
 * stamped with its capture time in microseconds and hands it to `post`, which
 * transfers it. Returns the stop.
 */
export const pumpFrames = (
  preview: HTMLVideoElement,
  post: (frame: VideoFrame) => void,
) =>
  onFrames(preview, (ms) => {
    let frame: VideoFrame | undefined;
    try {
      frame = new VideoFrame(preview, { timestamp: Math.round(ms * 1000) });
      post(frame);
    } catch {
      frame?.close();
    }
  });

export interface EngineAudio {
  source: AudioSource;
  transfer: Transferable[];
  /** The recorder paths: the recorder helper records `track` and posts each chunk on `port`. */
  recorder?: { port: MessagePort; track: MediaStreamAudioTrack };
}

/**
 * The engine's audio input for `path` (6.2.4, 6.3), from a clone of the microphone
 * track: an MSTP stream; the capture worklet loaded from `workletUrl` into `context`,
 * whose node port the engine receives, the node sounding nothing; or a channel for the
 * recorder helper. `processor` is the name the worklet registers.
 */
export async function audioSource(
  camera: Camera,
  path: AudioPath,
  context: AudioContext,
  workletUrl: string,
  processor = "zakadi-capture",
): Promise<EngineAudio> {
  if (!camera.audio || path === "none") {
    return { source: { kind: "none" }, transfer: [] };
  }
  const track = clone(camera, camera.audio);
  if (path === "webcodecs-mstp") {
    const { readable } = new MediaStreamTrackProcessor({ track });
    return {
      source: { kind: "readable", stream: readable },
      transfer: [readable],
    };
  }
  if (path === "webcodecs-worklet") {
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, processor);
    const input = context.createMediaStreamSource(new MediaStream([track]));
    input
      .connect(node)
      .connect(new GainNode(context, { gain: 0 }))
      .connect(context.destination);
    camera.stops.push(
      () => input.disconnect(),
      () => node.disconnect(),
    );
    return {
      source: { kind: "pcm", port: node.port, sampleRate: context.sampleRate },
      transfer: [node.port],
    };
  }
  const { port1, port2 } = new MessageChannel();
  return {
    source: {
      kind: "recorder",
      port: port2,
      container: path === "recorder-opus" ? "webm" : "mp4",
    },
    transfer: [port2],
    recorder: { port: port1, track },
  };
}
