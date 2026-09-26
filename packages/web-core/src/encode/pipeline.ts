import type { ConfigMsg } from "@zakadi/protocol";
import { audioConfig, audioFlags, check, videoConfig } from "./candidates.js";
import type { Candidate, Rung } from "./candidates.js";
import { crop, upright } from "./frame.js";
import { avcc, codecOf, unit } from "./h264.js";
import type {
  AudioSource,
  Chunk,
  EncodeEvent,
  Pipeline,
  VideoSource,
} from "./types.js";

export interface EncoderOptions {
  video: VideoSource;
  audio: AudioSource;
  /** Receives chunks, the clock origin, keyframe telemetry and errors, in order. */
  emit(e: EncodeEvent): void;
  /** `device_quirks` `prefer_software_encoder` (D94). */
  preferSoftware?: boolean;
  /** The microphone's `getSettings()`, reported in `config.audio`. */
  settings?: MediaTrackSettings;
}

type Fail = "encoder_error" | "capture_error";

const max = (xs: number[]): number => Math.max(...xs);

function bytes(d: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(d)
    ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
    : new Uint8Array(d);
}

/**
 * The `webcodecs` profile of spec/06-web-sdk.md 6.2.4: `VideoEncoder` and, on the
 * `webcodecs-mstp` and `webcodecs-worklet` paths, `AudioEncoder`, on the session media clock
 * of 6.2.5, with the rung switches, keyframes and boosts of 6.2.7.
 */
export function createEncoder(o: EncoderOptions): Pipeline {
  const { video: vs, audio: as, emit } = o;
  const redraw = upright();
  const cancels: (() => void)[] = [];
  // K samples per track: the track timebase minus performance.now() at read, in us (6.2.5).
  const kv: number[] = [];
  const ka: number[] = [];
  const last: [number, number] = [0, 0];
  let ladder: readonly Rung[] = [];
  let gopMs = 0;
  let started = false;
  let stopped = false;

  // The video encoder and the candidate it runs.
  let enc: VideoEncoder | undefined;
  let gen = 0;
  let cands: Candidate[] = [];
  let ci = -1;
  let vp8 = false;
  let codec = "";
  let lengthSize = 0;
  const cache: { sets?: Uint8Array[] | undefined } = {};

  // Input side: what the next frame is encoded with.
  let rung = 0;
  let decimation = 0;
  let selected = 0;
  let due = -Infinity;
  let lastKey = -Infinity;
  let keyRequested = false;
  let sizeChanged = false;
  let boost = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idrTs = Infinity;
  let idrAt = 0;
  // A configure() applies from the next submitted frame, `t` until then NaN (6.2.7).
  let barriers: { t: number; r: number; v: number }[] = [];

  // Output side: what the chunks coming out were encoded with.
  let out = 0;
  let kbps = 0;
  let needCodec = false;
  let sent = false;
  let held: Chunk[] = [];
  let drops = 0;
  const reads: number[] = [];

  // The media clock.
  let ready = false;
  let t0: number | undefined;
  let t0Perf = 0;
  let clockSource: "shared" | "aligned" = "aligned";

  // Audio.
  let aenc: AudioEncoder | undefined;
  let rate = as.kind === "pcm" ? as.sampleRate : 0;
  let akbps = 0;
  let pair: [number, number] | undefined;

  function fail(code: Fail, e: unknown): void {
    if (!stopped) emit({ k: "error", code, detail: String(e) });
  }

  function sample(ks: number[], v: number): void {
    ks.push(v);
    if (ks.length > 64) ks.shift();
  }

  function fps(now: number): number {
    while (reads.length && reads[0]! <= now - 1000) reads.shift();
    return reads.length;
  }

  // pts never decreases per track (6.2.5, spec/01-protocol.md 1.3.3).
  function pts(track: 0 | 1, ts: number): number {
    const k = track ? (as.kind === "readable" ? max(ka) : 0) : max(kv);
    const p = Math.floor(
      (clockSource === "shared" ? ts - (t0 ?? 0) : ts - k - t0Perf) / 1000,
    );
    return (last[track] = Math.max(last[track], p));
  }

  function config(): ConfigMsg {
    const r = ladder[out]!;
    const container = as.kind === "recorder" ? as.container : undefined;
    return {
      t: "config",
      video: {
        codec,
        w: r.w,
        h: r.h,
        fps: r.fps,
        bitrate_kbps: kbps,
        annexb: !vp8,
        container: null,
        mirrored: false,
        rotation: 0,
        gop_ms: gopMs,
      },
      audio: {
        codec: container === "mp4" ? "aac" : "opus",
        sample_rate:
          container === "mp4"
            ? (o.settings?.sampleRate ?? 48000)
            : rate || 48000,
        channels: 1,
        bitrate_kbps: akbps,
        ...(container ? { container } : { frame_ms: 20 }),
        ...audioFlags(o.settings ?? {}),
      },
      rung: out,
      clock_source: clockSource,
    };
  }

  // Audio waits for the first video chunk: `config` precedes the first media message, and
  // the level check applies before any media is sent (6.2.4).
  function put(c: Chunk, withConfig: boolean): void {
    if (withConfig) c.config = config();
    if (c.track === "audio" && !sent) {
      held.push(c);
      return;
    }
    emit(c);
    if (!sent) {
      sent = true;
      for (const h of held) emit(h);
      held = [];
    }
  }

  function configureVideo(): void {
    const r = ladder[rung]!;
    const v = boost || r.video_kbps;
    // A UA closes an encoder that failed; its error was reported.
    if (enc && enc.state !== "closed")
      enc.configure(videoConfig(r, cands[ci]!, v));
    const b = barriers[barriers.length - 1];
    if (b && isNaN(b.t)) Object.assign(b, { r: rung, v });
    else barriers.push({ t: NaN, r: rung, v });
  }

  // The next candidate of the 6.2.4 order, from its first frame.
  function next(): void {
    if (enc && enc.state !== "closed") enc.close();
    enc = undefined;
    const c = cands[++ci];
    if (!c) return fail("encoder_error", "no video encoder configuration left");
    const g = ++gen;
    const e = new VideoEncoder({
      output: (chunk, meta) => onChunk(g, chunk, meta),
      error: (x) => {
        if (g !== gen) return;
        if (sent) fail("encoder_error", x);
        else next();
      },
    });
    enc = e;
    vp8 = c.codec === "vp8";
    codec = c.codec;
    lengthSize = 0;
    cache.sets = undefined;
    barriers = [];
    lastKey = -Infinity;
    try {
      configureVideo();
    } catch {
      if (g === gen) next();
    }
  }

  function onFrame(f: VideoFrame): void {
    const now = performance.now();
    const ts = f.timestamp;
    sample(kv, ts - now * 1000);
    reads.push(now);
    fps(now);
    // t0 is the first frame the camera pipeline delivers after `ready` (6.2.5).
    if (ready && t0 === undefined) {
      t0 = ts;
      t0Perf = ts - max(kv);
      emit({ k: "t0", perfMs: t0Perf / 1000 });
    }
    const r = ladder[rung];
    const interval = r ? 1e6 / r.fps : 0;
    // Rung-rate selection by timestamp: not counted.
    if (
      !started ||
      stopped ||
      enc?.state !== "configured" ||
      ts < due - interval / 4
    ) {
      f.close();
      return;
    }
    due = ts - due > interval ? ts + interval : due + interval;
    // Decimation and backpressure: counted; a requested keyframe bypasses both (6.2.7).
    if (
      !keyRequested &&
      ((decimation && ++selected % (decimation === 1 ? 4 : 2) === 0) ||
        enc.encodeQueueSize > 2)
    ) {
      drops++;
      f.close();
      return;
    }
    const key = keyRequested || sizeChanged || ts - lastKey >= gopMs * 1000;
    const b = barriers[barriers.length - 1];
    if (b && isNaN(b.t)) b.t = ts;
    if (keyRequested) idrTs = ts;
    if (key) {
      lastKey = ts;
      keyRequested = sizeChanged = false;
    }
    // Every frame is closed once, right after encode() (which clones) or on failure.
    const frames = [f];
    try {
      const u = redraw(f);
      if (u !== f) frames.push(u);
      const c = crop(u);
      if (c !== u) frames.push(c);
      enc.encode(c, { keyFrame: key });
    } catch (e) {
      fail("encoder_error", e);
    }
    for (const x of frames) x.close();
  }

  function onChunk(
    g: number,
    c: EncodedVideoChunk,
    meta?: EncodedVideoChunkMetadata,
  ): void {
    if (g !== gen || stopped) return;
    const d = meta?.decoderConfig?.description;
    // An avcC description: a UA that ignored `annexb`.
    if (d) [lengthSize, cache.sets] = avcc(bytes(d));
    let data: Uint8Array = new Uint8Array(c.byteLength);
    c.copyTo(data);
    let key = c.type === "key";
    let ps = false;
    let sps: Uint8Array | undefined;
    if (!vp8) ({ data, key, ps, sps } = unit(data, lengthSize, cache));
    let withConfig = false;
    let rc = false;
    while (barriers[0] && barriers[0].t <= c.timestamp) {
      const b = barriers.shift()!;
      withConfig = needCodec = true;
      kbps = b.v;
      if (b.r !== out) {
        rc = true;
        out = b.r;
        // Opus moves to the rung's bitrate at the barrier (6.2.7 step 2).
        const k = ladder[out]!.audio_kbps;
        if (k !== akbps && as.kind !== "recorder") {
          akbps = k;
          if (aenc?.state === "configured")
            aenc.configure(audioConfig(rate, k));
        }
      }
    }
    if (key) lastKey = Math.max(lastKey, c.timestamp);
    // The SPS of the first key chunk after each configure() (6.2.4).
    if (needCodec && key) {
      needCodec = false;
      if (sps) {
        if (sps[3]! > 31 && !sent) return next();
        withConfig ||= codecOf(sps) !== codec;
        codec = codecOf(sps);
      }
    }
    if (key && c.timestamp >= idrTs) {
      idrTs = Infinity;
      emit({ k: "idr", ms: Math.round(performance.now() - idrAt) });
    }
    const ptsMs = pts(0, c.timestamp);
    put(
      { k: "chunk", track: "video", data, ptsMs, key, ps, rc, rung: out },
      withConfig,
    );
  }

  function audio(data: Uint8Array, ts: number): void {
    const ptsMs = pts(1, ts);
    put(
      {
        k: "chunk",
        track: "audio",
        data,
        ptsMs,
        key: false,
        ps: false,
        rc: false,
        rung: out,
      },
      false,
    );
  }

  function encodeAudio(a: AudioData): void {
    if (!started || stopped || t0 === undefined) {
      a.close();
      return;
    }
    const frames = [a];
    try {
      if (!aenc) {
        aenc = new AudioEncoder({
          output: (c) => {
            const data = new Uint8Array(c.byteLength);
            c.copyTo(data);
            if (!stopped) audio(data, c.timestamp);
          },
          error: (x) => fail("encoder_error", x),
        });
        aenc.configure(audioConfig(rate, akbps));
      }
      let m = a;
      // Plane 0 only: the channel the mono encoder is given.
      if (a.numberOfChannels > 1) {
        const plane = new Float32Array(a.numberOfFrames);
        a.copyTo(plane, { planeIndex: 0, format: "f32-planar" });
        frames.push((m = pcm(plane, a.sampleRate, a.timestamp)));
      }
      aenc.encode(m);
    } catch (e) {
      fail("encoder_error", e);
    }
    for (const x of frames) x.close();
  }

  const pcm = (
    data: Float32Array<ArrayBuffer>,
    sampleRate: number,
    timestamp: number,
  ): AudioData =>
    new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfChannels: 1,
      numberOfFrames: data.length,
      timestamp,
      data,
    });

  // A worklet block: context time mapped to the engine's clock through the latest
  // getOutputTimestamp() pair; before the first pair, its arrival less its 20 ms (6.2.5).
  function onBlock({
    t,
    d,
  }: {
    t: number;
    d: Float32Array<ArrayBuffer>;
  }): void {
    if (!started || stopped || t0 === undefined) return;
    const perfMs = pair
      ? pair[0] + (t - pair[1]) * 1000
      : performance.now() - 20;
    encodeAudio(pcm(d, rate, Math.round(perfMs * 1000)));
  }

  // A recorder chunk, unmodified, at the performance time `recordAudio` estimated (6.2.5).
  function onRecorded(m: { t?: number; d?: ArrayBuffer; e?: string }): void {
    if (!m.d) fail("encoder_error", m.e);
    else if (started && !stopped)
      audio(new Uint8Array(m.d), (m.t! - performance.timeOrigin) * 1000);
  }

  function onAudio(a: AudioData): void {
    sample(ka, a.timestamp - performance.now() * 1000);
    // The rate is that of the first AudioData; 16 kHz was only requested (6.2.4).
    rate ||= a.sampleRate;
    encodeAudio(a);
  }

  async function pump<T>(
    stream: ReadableStream<T>,
    on: (v: T) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    cancels.push(() => void reader.cancel().catch(() => undefined));
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read())
        on(r.value);
    } catch (e) {
      fail("capture_error", e);
    }
  }

  if (vs.kind === "readable") void pump(vs.stream, onFrame);
  if (vs.kind === "track") {
    const track = vs.track as MediaStreamVideoTrack;
    void pump(new MediaStreamTrackProcessor({ track }).readable, onFrame);
  }
  if (as.kind === "readable") void pump(as.stream, onAudio);
  if (as.kind === "pcm") as.port.onmessage = (e) => onBlock(e.data);
  if (as.kind === "recorder") as.port.onmessage = (e) => onRecorded(e.data);

  return {
    ready(msg) {
      ladder = msg.ladder;
      gopMs = msg.gop_ms;
      ready = true;
    },

    async start(r) {
      rung = out = r;
      akbps = ladder[r]?.audio_kbps ?? 0;
      // A shared capture clock when the tracks' K agree within 20 ms (6.2.5).
      const shared =
        as.kind === "readable" && Math.abs(max(ka) - max(kv)) < 20000;
      clockSource = shared ? "shared" : "aligned";
      cands = (await check(ladder, o.preferSoftware)).ok;
      if (stopped) return;
      next();
      started = true;
      if (as.kind === "recorder") as.port.postMessage({ kbps: akbps });
    },

    rung(to, d) {
      decimation = d;
      const a = ladder[rung];
      const b = ladder[to];
      if (to === rung || !a || !b) return;
      sizeChanged ||= a.w !== b.w || a.h !== b.h;
      // Frame selection switches at once.
      due += 1e6 / b.fps - 1e6 / a.fps;
      rung = to;
      // A rung change ends a boost.
      clearTimeout(timer);
      boost = 0;
      if (enc) configureVideo();
    },

    keyframe({ boost_kbps, boost_ms }) {
      if (!enc || stopped) return;
      keyRequested = true;
      idrAt = performance.now();
      if (!boost_kbps || !boost_ms) return;
      // boost_kbps is an absolute ceiling for boost_ms (spec/01-protocol.md 1.5).
      boost = boost_kbps;
      configureVideo();
      clearTimeout(timer);
      timer = setTimeout(() => {
        boost = 0;
        if (!stopped) configureVideo();
      }, boost_ms);
    },

    frame: onFrame,

    clock(perfMs, contextTime) {
      pair = [perfMs, contextTime];
    },

    stats() {
      return {
        enc_queue: enc?.encodeQueueSize ?? 0,
        pre_encode_drops: drops,
        captured_fps: fps(performance.now()),
      };
    },

    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      for (const cancel of cancels) cancel();
      if (vs.kind === "track") vs.track.stop();
      for (const e of [enc, aenc]) if (e && e.state !== "closed") e.close();
      if (as.kind === "recorder") as.port.postMessage(null);
      if (as.kind === "pcm" || as.kind === "recorder") as.port.onmessage = null;
      held = [];
    },
  };
}
