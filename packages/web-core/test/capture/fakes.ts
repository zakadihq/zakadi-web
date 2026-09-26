// Fakes of getUserMedia, MediaStreamTrack, MediaStream and requestVideoFrameCallback
// for the detect, capture and probe tests, and for the session tests of Z-047. Every
// delay runs on setTimeout, so vi.useFakeTimers() drives them.
import { vi } from "vitest";

let ids = 0;

export interface FakeTrackInit {
  kind?: "video" | "audio";
  label?: string;
  settings?: MediaTrackSettings;
  /** Raw getCapabilities() values; undefined removes getCapabilities (KaiOS). */
  capabilities?: Record<string, unknown> | undefined;
  /** Milliseconds each applyConstraints call takes. */
  applyMs?: number;
  /**
   * The settings a constraint set yields. The default takes a bare or ideal `height`
   * and `frameRate` as they are, with the width at 3:4.
   */
  resolve?: (
    constraints: MediaTrackConstraints,
    current: MediaTrackSettings,
  ) => MediaTrackSettings;
}

const bare = (c: unknown) =>
  typeof c === "number" ? c : (c as { ideal?: number } | undefined)?.ideal;

const takeAsGiven: NonNullable<FakeTrackInit["resolve"]> = (c, s) => {
  const height = bare(c.height);
  const frameRate = bare(c.frameRate);
  return {
    ...s,
    ...(height === undefined
      ? {}
      : { height, width: Math.round(height * 0.75) }),
    ...(frameRate === undefined ? {} : { frameRate }),
  };
};

/**
 * A MediaStreamTrack. A clone shares its source's settings, as a camera shared by
 * several tracks does, and records its source in `source`.
 */
export class FakeTrack {
  readonly id = `track-${++ids}`;
  readonly kind: "video" | "audio";
  label: string;
  enabled = true;
  readyState: MediaStreamTrackState = "live";
  applyMs: number;
  resolve: NonNullable<FakeTrackInit["resolve"]>;
  /** Every constraint set passed to applyConstraints, in call order. */
  readonly applied: MediaTrackConstraints[] = [];
  readonly clones: FakeTrack[] = [];
  readonly source: FakeTrack | undefined;
  private state: { settings: MediaTrackSettings };
  private capabilities: Record<string, unknown> | undefined;

  constructor(init: FakeTrackInit = {}, source?: FakeTrack) {
    this.kind = init.kind ?? "video";
    this.label = init.label ?? `${this.kind} 1`;
    this.applyMs = init.applyMs ?? 0;
    this.resolve = init.resolve ?? takeAsGiven;
    this.source = source;
    this.state = source?.state ?? {
      settings: { deviceId: `${this.kind}-device`, ...init.settings },
    };
    this.capabilities =
      "capabilities" in init
        ? init.capabilities
        : { width: { min: 1, max: 1280 } };
    if (this.capabilities === undefined) {
      (this as { getCapabilities?: unknown }).getCapabilities = undefined;
    }
  }

  get settings(): MediaTrackSettings {
    return this.state.settings;
  }

  set settings(value: MediaTrackSettings) {
    this.state.settings = value;
  }

  clone(): FakeTrack {
    const copy = new FakeTrack(
      {
        kind: this.kind,
        label: this.label,
        capabilities: this.capabilities,
        applyMs: this.applyMs,
        resolve: this.resolve,
      },
      this,
    );
    this.clones.push(copy);
    return copy;
  }

  stop(): void {
    this.readyState = "ended";
  }

  getSettings(): MediaTrackSettings {
    return { ...this.state.settings };
  }

  getCapabilities(): Record<string, unknown> {
    return structuredClone(this.capabilities ?? {});
  }

  getConstraints(): MediaTrackConstraints {
    return this.applied[this.applied.length - 1] ?? {};
  }

  applyConstraints(constraints: MediaTrackConstraints = {}): Promise<void> {
    this.applied.push(constraints);
    return new Promise((resolve) =>
      setTimeout(() => {
        this.state.settings = this.resolve(constraints, this.state.settings);
        resolve();
      }, this.applyMs),
    );
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

/** A MediaStream over FakeTracks; stubbed as the global MediaStream. */
export class FakeStream {
  readonly tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }

  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}

/**
 * A getUserMedia that answers each call with the next entry of `results`: a stream of
 * those tracks, or a rejection with that error. `calls` holds the constraints.
 */
export function fakeGetUserMedia(...results: (FakeTrack[] | Error)[]) {
  return vi.fn(async (constraints: MediaStreamConstraints) => {
    void constraints;
    const next = results.shift();
    if (next === undefined) throw new Error("fakeGetUserMedia: no result left");
    if (next instanceof Error) throw next;
    return new FakeStream(next);
  });
}

/** A DOMException with that name, as getUserMedia rejects. */
export const mediaError = (name: string) => new DOMException(name, name);

/** An enumerateDevices() entry. */
export const deviceInfo = (
  kind: MediaDeviceKind,
  deviceId: string,
  groupId: string,
  label = "",
): MediaDeviceInfo =>
  ({
    kind,
    deviceId,
    groupId,
    label,
    toJSON: () => ({ kind, deviceId, groupId, label }),
  }) as MediaDeviceInfo;

/**
 * Stubs navigator.mediaDevices (with `getUserMedia` and `enumerateDevices`), the
 * global MediaStream and `extra` navigator fields. Undo with vi.unstubAllGlobals().
 */
export function installMedia(
  media: {
    getUserMedia?: unknown;
    enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
  },
  extra: Record<string, unknown> = {},
) {
  vi.stubGlobal("navigator", {
    userAgent: "fake",
    mediaDevices: { enumerateDevices: async () => [], ...media },
    ...extra,
  });
  vi.stubGlobal("MediaStream", FakeStream);
}

/**
 * A video element with requestVideoFrameCallback. `present()` shows one frame: the
 * callbacks pending at that moment run once with the metadata given.
 */
export class FakeVideo {
  muted = false;
  playsInline = false;
  autoplay = false;
  srcObject: unknown = null;
  readonly style = { cssText: "" };
  played = false;
  removed = false;
  private callbacks = new Map<number, VideoFrameRequestCallback>();
  private next = 0;

  requestVideoFrameCallback(cb: VideoFrameRequestCallback): number {
    this.callbacks.set(++this.next, cb);
    return this.next;
  }

  cancelVideoFrameCallback(id: number): void {
    this.callbacks.delete(id);
  }

  /** The number of callbacks waiting for the next frame. */
  get pending(): number {
    return this.callbacks.size;
  }

  present(
    meta: Partial<VideoFrameCallbackMetadata> & {
      width: number;
      height: number;
    },
  ): void {
    const now = performance.now();
    const full: VideoFrameCallbackMetadata = {
      expectedDisplayTime: now,
      presentationTime: now,
      mediaTime: 0,
      presentedFrames: 0,
      ...meta,
    };
    const due = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const cb of due) cb(now, full);
  }

  play(): Promise<void> {
    this.played = true;
    return Promise.resolve();
  }

  remove(): void {
    this.removed = true;
  }
}

/** A video element without requestVideoFrameCallback (Firefox before 132, KaiOS). */
export class FakePlainVideo {
  muted = false;
  playsInline = false;
  srcObject: unknown = null;
  readonly style = { cssText: "" };
}

/**
 * A document whose createElement("video") returns `video`, with a body that records
 * appended nodes. Stub it with vi.stubGlobal("document", fakeDocument(video)).
 */
export function fakeDocument(video: object) {
  const appended: unknown[] = [];
  return {
    appended,
    createElement: vi.fn(() => video),
    body: { append: (node: unknown) => appended.push(node) },
  };
}

/** A VideoFrame as MediaStreamTrackProcessor yields it: timestamp in microseconds. */
export interface FakeFrame {
  timestamp: number;
  displayWidth: number;
  displayHeight: number;
  closed: boolean;
  close(): void;
}

export const fakeFrame = (
  timestamp: number,
  w: number,
  h: number,
): FakeFrame => {
  const frame = {
    timestamp,
    displayWidth: w,
    displayHeight: h,
    closed: false,
    close: () => {
      frame.closed = true;
    },
  };
  return frame;
};

/**
 * A minimal main-thread MediaStreamTrackProcessor for these tests (the WebCodecs and
 * MSTP fakes of the encoder are Z-044's): `push()` enqueues a frame on `readable`.
 */
export class FakeProcessor {
  static readonly instances: FakeProcessor[] = [];
  readonly track: FakeTrack;
  readonly readable: ReadableStream<FakeFrame>;
  cancelled = false;
  private controller!: ReadableStreamDefaultController<FakeFrame>;

  constructor(init: { track: FakeTrack }) {
    this.track = init.track;
    this.readable = new ReadableStream<FakeFrame>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
    FakeProcessor.instances.push(this);
  }

  push(frame: FakeFrame): void {
    this.controller.enqueue(frame);
  }
}
