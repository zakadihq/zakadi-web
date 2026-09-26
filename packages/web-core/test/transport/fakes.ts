import type { ClientMsg } from "@zakadi/protocol";
import { vi } from "vitest";
import type { Decimation, Rung } from "../../src/control/loop";
import type { Socket } from "../../src/transport/client";
import type {
  Chunk,
  Media,
  MediaConfig,
  MediaCounters,
} from "../../src/transport/media";
import { sha256 } from "./node";
import { readHeader } from "./read";

// Fakes for the transport on vitest's virtual clock (spec/06-web-sdk.md 6.11): a
// WebSocket with a scriptable bufferedAmount and the media interface. The engine host
// (Z-047) reuses them.

/**
 * crypto.subtle.digest resolved as a microtask, so the chain's promise queue settles on
 * the virtual clock like everything else; the chain vectors run on the real one.
 */
export function microtaskDigest() {
  return vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(async (_alg, data) => {
      const u8 = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      return new Uint8Array(sha256(u8)).buffer;
    });
}

/** One thing the client sent: parsed JSON, or the bytes of a binary message. */
export interface Sent {
  at: number;
  msg?: ClientMsg;
  bin?: Uint8Array;
}

export class FakeSocket implements Socket {
  static all: FakeSocket[] = [];
  readyState = 0;
  protocol = "";
  binaryType: BinaryType = "blob";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  sent: Sent[] = [];
  /** The close the client asked for, if any. */
  closedWith: { code: number | undefined } | null = null;
  /** Bytes per second leaving the send buffer; Infinity empties it as time passes. */
  uplink = Infinity;
  private backlog = 0;
  private last = performance.now();

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.all.push(this);
  }

  get bufferedAmount(): number {
    this.drain();
    return Math.round(this.backlog);
  }

  /** Scripts the send buffer directly. */
  set bufferedAmount(v: number) {
    this.drain();
    this.backlog = v;
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) throw new Error("send() while not open");
    this.drain();
    const at = performance.now();
    if (typeof data === "string") {
      this.sent.push({ at, msg: JSON.parse(data) });
      this.backlog += data.length;
    } else {
      this.sent.push({ at, bin: new Uint8Array(data.slice(0)) });
      this.backlog += data.byteLength;
    }
  }

  close(code?: number): void {
    if (this.readyState > 1) return;
    this.closedWith = { code };
    this.readyState = 2;
    setTimeout(() => this.end(code ?? 1005, ""), 0);
  }

  /** The handshake completes with the server's chosen subprotocol. */
  open(protocol = "zakadi.v1"): void {
    this.readyState = 1;
    this.protocol = protocol;
    this.onopen?.(new Event("open"));
  }

  receive(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }

  /** The connection fails (before or after open). */
  fail(): void {
    this.end(1006, "");
  }

  serverClose(code: number, reason = ""): void {
    this.end(code, reason);
  }

  /** The JSON messages sent, optionally of one type. */
  texts(t?: string): ClientMsg[] {
    return this.sent.flatMap((s) =>
      s.msg && (!t || s.msg.t === t) ? [s.msg] : [],
    );
  }

  /** The binary messages sent, optionally of one header type. */
  bins(type?: number): Uint8Array[] {
    return this.sent.flatMap((s) =>
      s.bin && (type === undefined || readHeader(s.bin).type === type)
        ? [s.bin]
        : [],
    );
  }

  private end(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  private drain(): void {
    const t = performance.now();
    if (this.uplink === Infinity) {
      if (t > this.last) this.backlog = 0;
    } else {
      this.backlog = Math.max(
        0,
        this.backlog - (this.uplink * (t - this.last)) / 1000,
      );
    }
    this.last = t;
  }
}

/**
 * Capture and encode on the virtual clock: video frames at the rung's frame rate less
 * the decimation, sized at the rung's video rate (keyframes 5 times larger, every
 * `gopMs`), and 20 ms audio packets at the rung's audio rate, one before the first video
 * frame. Every call is logged in `calls`.
 */
export class FakeMedia implements Media {
  calls: unknown[][] = [];
  config: MediaConfig = {
    video: {
      codec: "avc1.42E01F",
      annexb: true,
      container: null,
      gop_ms: 2000,
    },
    audio: {
      codec: "opus",
      sample_rate: 16000,
      channels: 1,
      frame_ms: 20,
      muxed_in_video: false,
      echo_cancellation: false,
      noise_suppression: false,
      auto_gain: false,
    },
    clock_source: "shared",
  };
  counts: MediaCounters = {
    enc_queue: 1,
    pre_encode_drops: 0,
    captured_fps: 15,
  };
  gopMs = 2000;
  /** False: no audio chunks (the recorder muxes audio into video). */
  audio = true;
  private rung: Rung | undefined;
  private dec: Decimation = 0;
  private out: ((c: Chunk) => void) | undefined;
  private t0: number | null = null;
  private n = 0;
  private key = true;
  private lastKey = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];

  start(rung: Rung, out: (c: Chunk) => void): void {
    this.calls.push(["start", rung.rung]);
    this.rung = rung;
    this.out = out;
    if (this.audio) this.sound();
    this.after(30, () => this.frame());
  }

  apply(rung: Rung, decimation: Decimation): void {
    this.calls.push(["apply", rung.rung, decimation]);
    if (rung.w !== this.rung!.w || rung.h !== this.rung!.h) this.key = true;
    this.rung = rung;
    this.dec = decimation;
  }

  keyframe(boostKbps?: number, boostMs?: number): void {
    this.calls.push(["keyframe", boostKbps, boostMs]);
    this.key = true;
  }

  stop(): void {
    this.calls.push(["stop"]);
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  describe(): MediaConfig {
    return this.config;
  }

  origin(): number | null {
    return this.t0;
  }

  counters(): MediaCounters {
    return this.counts;
  }

  private after(ms: number, f: () => void): void {
    this.timers.push(setTimeout(f, ms));
  }

  private ts(): number {
    return this.t0 === null ? 0 : Math.floor(performance.now() - this.t0);
  }

  private frame(): void {
    const r = this.rung!;
    this.after(1000 / r.fps, () => this.frame());
    const now = performance.now();
    this.t0 ??= now;
    if (now - this.lastKey >= this.gopMs) this.key = true;
    const n = this.n++;
    const skip = this.dec === 1 ? n % 4 === 3 : this.dec === 2 && n % 2 === 1;
    if (skip && !this.key) return;
    const key = this.key;
    this.key = false;
    if (key) this.lastKey = now;
    const bytes = Math.round((r.video_kbps * 125) / r.fps) * (key ? 5 : 1);
    this.out!({
      data: new Uint8Array(bytes),
      ts: this.ts(),
      key,
      ps: key,
      rung: r.rung,
    });
  }

  private sound(): void {
    this.after(20, () => this.sound());
    const r = this.rung!;
    this.out!({
      audio: true,
      data: new Uint8Array(Math.round((r.audio_kbps * 125) / 50)),
      ts: this.ts(),
      rung: r.rung,
    });
  }
}
