// Fakes of WebCodecs, MSTP, OffscreenCanvas and MediaRecorder for Node (spec/06-web-sdk.md
// 6.11), installed as globals by installFakes(). They record what the code under test did
// and emit outputs only when a test calls drain(), as a UA does asynchronously.
import { vi } from "vitest";

type Rect = { x: number; y: number; width: number; height: number };

/** H.264 NAL units for fake access units; none contains or ends with a zero byte. */
export const sps = (level = 0x1f, profile = 0x42, flags = 0xe0): Uint8Array =>
  Uint8Array.of(0x67, profile, flags, level, 0x8d, 0x68, 0x3c);
export const PPS = Uint8Array.of(0x68, 0xce, 0x3c, 0x80);
export const IDR = Uint8Array.of(0x65, 0x88, 0x84, 0x21, 0x3f);
export const SLICE = Uint8Array.of(0x41, 0x9a, 0x21, 0x6c);

/** NAL units with 4-byte start codes (Annex-B). */
export function annexB(...units: Uint8Array[]): Uint8Array {
  return concat(units.flatMap((u) => [Uint8Array.of(0, 0, 0, 1), u]));
}

/** NAL units with 4-byte big-endian length prefixes (avcC). */
export function lengthPrefixed(...units: Uint8Array[]): Uint8Array {
  return concat(
    units.flatMap((u) => [
      Uint8Array.of(0, 0, u.length >> 8, u.length & 255),
      u,
    ]),
  );
}

/** An avcC record with one SPS and one PPS and 4-byte NAL lengths. */
export function avccRecord(s: Uint8Array, p: Uint8Array): Uint8Array {
  const size = (u: Uint8Array) => Uint8Array.of(u.length >> 8, u.length & 255);
  return concat([
    Uint8Array.of(1, s[1]!, s[2]!, s[3]!, 0xff, 0xe1),
    size(s),
    s,
    Uint8Array.of(1),
    size(p),
    p,
  ]);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export class FakeVideoFrame {
  static all: FakeVideoFrame[] = [];
  static live = 0;
  static peak = 0;
  readonly timestamp: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: Rect;
  readonly rotation: number;
  readonly flip: boolean;
  closes = 0;

  /** A camera frame, as MSTP or the rVFC path delivers it. */
  static camera(o: {
    width: number;
    height: number;
    timestamp: number;
    rotation?: number;
    flip?: boolean;
  }): VideoFrame {
    return new FakeVideoFrame({
      ...o,
      rect: { x: 0, y: 0, width: o.width, height: o.height },
    }) as unknown as VideoFrame;
  }

  // The real constructor takes an image source (a frame or a canvas) and an init.
  constructor(
    src:
      | FakeVideoFrame
      | FakeOffscreenCanvas
      | {
          width: number;
          height: number;
          timestamp: number;
          rect: Rect;
          rotation?: number;
          flip?: boolean;
        },
    init: { timestamp?: number; visibleRect?: Rect } = {},
  ) {
    if (src instanceof FakeVideoFrame) {
      if (src.closes)
        throw new DOMException("closed source frame", "InvalidStateError");
      this.codedWidth = src.codedWidth;
      this.codedHeight = src.codedHeight;
      this.timestamp = init.timestamp ?? src.timestamp;
      this.rotation = src.rotation;
      this.flip = src.flip;
      const r = init.visibleRect ?? src.visibleRect;
      const odd = [r.x, r.y, r.width, r.height].some((v) => v % 2 !== 0);
      if (
        odd ||
        r.x < 0 ||
        r.y < 0 ||
        r.x + r.width > src.codedWidth ||
        r.y + r.height > src.codedHeight
      ) {
        throw new TypeError(
          `visibleRect ${JSON.stringify(r)} is not an even region of the frame`,
        );
      }
      this.visibleRect = r;
    } else if (src instanceof FakeOffscreenCanvas) {
      if (init.timestamp === undefined)
        throw new TypeError("timestamp is required for a canvas");
      this.codedWidth = src.width;
      this.codedHeight = src.height;
      this.timestamp = init.timestamp;
      this.rotation = 0;
      this.flip = false;
      this.visibleRect = { x: 0, y: 0, width: src.width, height: src.height };
    } else {
      this.codedWidth = src.width;
      this.codedHeight = src.height;
      this.timestamp = src.timestamp;
      this.rotation = src.rotation ?? 0;
      this.flip = src.flip ?? false;
      this.visibleRect = src.rect;
    }
    this.displayWidth = this.visibleRect.width;
    this.displayHeight = this.visibleRect.height;
    FakeVideoFrame.all.push(this);
    FakeVideoFrame.peak = Math.max(FakeVideoFrame.peak, ++FakeVideoFrame.live);
  }

  close(): void {
    if (this.closes++ === 0) FakeVideoFrame.live--;
  }
}

export class FakeOffscreenCanvas {
  static all: FakeOffscreenCanvas[] = [];
  draws: { frame: FakeVideoFrame; w: number; h: number }[] = [];

  constructor(
    public width: number,
    public height: number,
  ) {
    FakeOffscreenCanvas.all.push(this);
  }

  getContext(kind: string): unknown {
    if (kind !== "2d") return null;
    return {
      drawImage: (
        frame: FakeVideoFrame,
        x: number,
        y: number,
        w: number,
        h: number,
      ) => {
        if (frame.closes)
          throw new DOMException("closed frame", "InvalidStateError");
        if (x || y) throw new Error("the fake draws at the origin only");
        this.draws.push({ frame, w, h });
      },
    };
  }
}

export class FakeEncodedChunk {
  constructor(
    readonly type: "key" | "delta",
    readonly timestamp: number,
    readonly data: Uint8Array,
  ) {}

  get byteLength(): number {
    return this.data.length;
  }

  copyTo(dest: Uint8Array): void {
    dest.set(this.data);
  }
}

/** One encode() call: what the fake was given and with which configuration. */
export interface Encoded {
  timestamp: number;
  keyFrame: boolean;
  config: VideoEncoderConfig;
  rect: Rect;
  width: number;
  height: number;
}

/** A fake access unit: the payload, its chunk type and optional metadata. */
export type Output = {
  data: Uint8Array;
  type: "key" | "delta";
  meta?: EncodedVideoChunkMetadata;
};

/** The default output: VP8 frames, or Annex-B with SPS and PPS on every H.264 key frame. */
export function writeAnnexB(e: Encoded): Output {
  if (e.config.codec === "vp8") {
    return {
      data: Uint8Array.of(e.keyFrame ? 0x10 : 0x11, 0x02, 0x9d),
      type: e.keyFrame ? "key" : "delta",
    };
  }
  return e.keyFrame
    ? { data: annexB(sps(FakeVideoEncoder.level), PPS, IDR), type: "key" }
    : { data: annexB(SLICE), type: "delta" };
}

export class FakeVideoEncoder {
  static all: FakeVideoEncoder[] = [];
  /** Every configuration isConfigSupported() was asked about. */
  static checked: VideoEncoderConfig[] = [];
  static supported: (c: VideoEncoderConfig) => boolean = () => true;
  /** The level_idc of the SPS the fake writes. */
  static level = 0x1f;
  /** How the fake encodes a frame; installFakes() restores writeAnnexB. */
  static write: (e: Encoded) => Output = writeAnnexB;

  static async isConfigSupported(
    config: VideoEncoderConfig,
  ): Promise<VideoEncoderSupport> {
    FakeVideoEncoder.checked.push(config);
    return {
      supported: FakeVideoEncoder.supported(config),
      config: { ...config },
    };
  }

  state: CodecState = "unconfigured";
  configs: VideoEncoderConfig[] = [];
  encoded: Encoded[] = [];
  queue: Encoded[] = [];

  constructor(readonly init: VideoEncoderInit) {
    FakeVideoEncoder.all.push(this);
  }

  get encodeQueueSize(): number {
    return this.queue.length;
  }

  configure(config: VideoEncoderConfig): void {
    if (this.state === "closed")
      throw new DOMException("closed", "InvalidStateError");
    this.configs.push(config);
    this.state = "configured";
  }

  encode(f: FakeVideoFrame, o: VideoEncoderEncodeOptions = {}): void {
    if (this.state !== "configured")
      throw new DOMException("not configured", "InvalidStateError");
    if (f.closes) throw new TypeError("closed frame");
    const e: Encoded = {
      timestamp: f.timestamp,
      keyFrame: !!o.keyFrame,
      config: this.configs[this.configs.length - 1]!,
      rect: f.visibleRect,
      width: f.codedWidth,
      height: f.codedHeight,
    };
    this.encoded.push(e);
    this.queue.push(e);
  }

  /** Outputs every queued frame, in order; the first output after a configure carries metadata. */
  drain(write = FakeVideoEncoder.write): void {
    for (const e of this.queue.splice(0)) {
      const o = write(e);
      this.init.output(
        new FakeEncodedChunk(
          o.type,
          e.timestamp,
          o.data,
        ) as unknown as EncodedVideoChunk,
        o.meta,
      );
    }
  }

  close(): void {
    this.state = "closed";
    this.queue = [];
  }
}

export class FakeAudioData {
  static all: FakeAudioData[] = [];
  static live = 0;
  readonly format: AudioSampleFormat;
  readonly sampleRate: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly timestamp: number;
  readonly planes: Float32Array[] = [];
  closes = 0;

  /** Microphone audio, as MSTP delivers it: `channels` planes of a ramp from `first`. */
  static mic(o: {
    timestamp: number;
    sampleRate?: number;
    frames?: number;
    channels?: number;
    first?: number;
  }): AudioData {
    const frames = o.frames ?? 480;
    const channels = o.channels ?? 1;
    const data = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c++)
      for (let i = 0; i < frames; i++)
        data[c * frames + i] = c * 1000 + (o.first ?? 0) + i;
    return new FakeAudioData({
      format: "f32-planar",
      sampleRate: o.sampleRate ?? 48000,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: o.timestamp,
      data,
    }) as unknown as AudioData;
  }

  constructor(init: AudioDataInit) {
    if (init.format !== "f32-planar")
      throw new TypeError("the fake takes f32-planar data only");
    this.format = init.format;
    this.sampleRate = init.sampleRate;
    this.numberOfFrames = init.numberOfFrames;
    this.numberOfChannels = init.numberOfChannels;
    this.timestamp = init.timestamp;
    const src = init.data as Float32Array;
    for (let c = 0; c < init.numberOfChannels; c++) {
      this.planes.push(
        src.slice(c * init.numberOfFrames, (c + 1) * init.numberOfFrames),
      );
    }
    FakeAudioData.all.push(this);
    FakeAudioData.live++;
  }

  copyTo(dest: Float32Array, o: AudioDataCopyToOptions): void {
    if (o.format !== "f32-planar")
      throw new TypeError("the fake copies to f32-planar only");
    dest.set(this.planes[o.planeIndex]!);
  }

  close(): void {
    if (this.closes++ === 0) FakeAudioData.live--;
  }
}

export class FakeAudioEncoder {
  static all: FakeAudioEncoder[] = [];
  state: CodecState = "unconfigured";
  configs: AudioEncoderConfig[] = [];
  encoded: {
    timestamp: number;
    channels: number;
    frames: number;
    first: number;
    kbps: number;
  }[] = [];
  queue: number[] = [];

  constructor(readonly init: AudioEncoderInit) {
    FakeAudioEncoder.all.push(this);
  }

  configure(config: AudioEncoderConfig): void {
    if (this.state === "closed")
      throw new DOMException("closed", "InvalidStateError");
    this.configs.push(config);
    this.state = "configured";
  }

  encode(a: FakeAudioData): void {
    if (this.state !== "configured")
      throw new DOMException("not configured", "InvalidStateError");
    if (a.closes) throw new TypeError("closed AudioData");
    const kbps = this.configs[this.configs.length - 1]!.bitrate! / 1000;
    this.encoded.push({
      timestamp: a.timestamp,
      channels: a.numberOfChannels,
      frames: a.numberOfFrames,
      first: a.planes[0]![0]!,
      kbps,
    });
    this.queue.push(a.timestamp);
  }

  /** One packet per queued AudioData, at its timestamp. */
  drain(): void {
    for (const t of this.queue.splice(0)) {
      this.init.output(
        new FakeEncodedChunk(
          "key",
          t,
          Uint8Array.of(0x78, t & 255),
        ) as unknown as EncodedAudioChunk,
      );
    }
  }

  close(): void {
    this.state = "closed";
  }
}

/** A readable source the test pushes values into, as an MSTP readable. */
export function source<T>(): {
  stream: ReadableStream<T>;
  push(v: T): void;
  end(): void;
} {
  let ctl!: ReadableStreamDefaultController<T>;
  const stream = new ReadableStream<T>({ start: (c) => void (ctl = c) });
  return { stream, push: (v) => ctl.enqueue(v), end: () => ctl.close() };
}

export class FakeTrack {
  stopped = false;

  constructor(
    readonly kind: "audio" | "video",
    readonly settings: MediaTrackSettings = {},
  ) {}

  getSettings(): MediaTrackSettings {
    return this.settings;
  }

  stop(): void {
    this.stopped = true;
  }
}

export class FakeMediaStreamTrackProcessor {
  static all: FakeMediaStreamTrackProcessor[] = [];
  readonly track: FakeTrack;
  readonly readable: ReadableStream<VideoFrame>;
  readonly push: (f: VideoFrame) => void;

  constructor(init: { track: FakeTrack }) {
    const s = source<VideoFrame>();
    this.track = init.track;
    this.readable = s.stream;
    this.push = s.push;
    FakeMediaStreamTrackProcessor.all.push(this);
  }
}

export class FakeMediaStream {
  constructor(readonly tracks: FakeTrack[] = []) {}

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}

export class FakeMediaRecorder {
  static all: FakeMediaRecorder[] = [];
  state: RecordingState = "inactive";
  timeslice: number | undefined;
  onstart: ((e: Event) => void) | null = null;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  constructor(
    readonly stream: FakeMediaStream,
    readonly options: MediaRecorderOptions = {},
  ) {
    FakeMediaRecorder.all.push(this);
  }

  start(timeslice?: number): void {
    this.state = "recording";
    this.timeslice = timeslice;
    queueMicrotask(() => this.onstart?.(new Event("start")));
  }

  stop(): void {
    this.state = "inactive";
  }

  /** Delivers `bytes` as the next `dataavailable` chunk. */
  push(bytes: Uint8Array): void {
    this.ondataavailable?.({
      data: new Blob([bytes as Uint8Array<ArrayBuffer>]),
    });
  }
}

/** Two linked ports whose messages arrive in a microtask, as a MessageChannel's do. */
export function channel(): [MessagePort, MessagePort] {
  type Port = {
    onmessage: ((e: { data: unknown }) => void) | null;
    postMessage(d: unknown): void;
    other?: Port;
  };
  const port = (): Port => ({
    onmessage: null,
    postMessage(data) {
      queueMicrotask(() => this.other?.onmessage?.({ data }));
    },
  });
  const a = port();
  const b = port();
  a.other = b;
  b.other = a;
  return [a as unknown as MessagePort, b as unknown as MessagePort];
}

// Node's setImmediate, which the fake timers leave real; lib.dom does not declare it.
const immediate = (
  globalThis as unknown as { setImmediate(f: () => void): void }
).setImmediate;

/** Lets pending promise jobs and queued microtasks run. */
export const settle = (): Promise<void> => new Promise((r) => immediate(r));

/** Installs the fakes as globals, empties their records and fakes the timers and performance.now(). */
export function installFakes(): void {
  for (const c of [
    FakeVideoFrame,
    FakeOffscreenCanvas,
    FakeVideoEncoder,
    FakeAudioData,
    FakeAudioEncoder,
  ]) {
    c.all = [] as never;
  }
  FakeMediaStreamTrackProcessor.all = [];
  FakeMediaRecorder.all = [];
  FakeVideoEncoder.checked = [];
  FakeVideoEncoder.supported = () => true;
  FakeVideoEncoder.level = 0x1f;
  FakeVideoEncoder.write = writeAnnexB;
  FakeVideoFrame.live = FakeVideoFrame.peak = FakeAudioData.live = 0;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
    now: 0,
  });
  vi.stubGlobal("VideoFrame", FakeVideoFrame);
  vi.stubGlobal("VideoEncoder", FakeVideoEncoder);
  vi.stubGlobal("AudioData", FakeAudioData);
  vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  vi.stubGlobal("MediaStreamTrackProcessor", FakeMediaStreamTrackProcessor);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
}

/** Removes the fakes and restores the real timers. */
export function removeFakes(): void {
  vi.unstubAllGlobals();
  vi.useRealTimers();
}
