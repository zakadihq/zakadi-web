import type { ReadyMsg } from "@zakadi/protocol";

// The transport control loop of spec/05-sdk-contract.md 5.6 as a pure function
// (spec/06-web-sdk.md 6.2.8), and the caller's bookkeeping around it. Nothing here
// reads a clock or a socket: times and queue sizes come in as arguments.

/** A ladder entry of `ready` (01 1.5); index 0 is the highest quality. */
export type Rung = ReadyMsg["ladder"][number];
/** 0, 1 or 2: keep every frame, drop every 4th, drop every 2nd (5.6). */
export type Decimation = 0 | 1 | 2;

export interface LoopState {
  rung: number;
  decimation: Decimation;
  queueSamples: number[];
  /** Server `ping.rtt_ms` and own ping/pong samples, the whole session (at most 600). */
  rttSamples: { at: number; ms: number }[];
  /** Server `ping.rx_kbps` samples. */
  rxSamples: { at: number; kbps: number }[];
  /** Any IDR emitted; the last server `keyframe`. */
  lastKeyframeAt: number;
  lastKeyframeRequestAt: number;
  dwellStart: number;
  lastDownAt: number;
  over600: number;
  floorTicks: number;
  overrideUntil: number;
  /** mediarecorder: false, and floorRung is the recorder's rung (5.6). */
  canChange: boolean;
  floorRung: number;
  /** device_quirks max_rung, else 0. */
  bestRung: number;
}

export interface TickIn {
  now: number;
  queuedBytes: number;
  drainedBytes1s: number;
  encodedKbps2s: number;
  ladder: Rung[];
}

export type TickOut =
  | { kind: "hold" }
  | { kind: "floor_breached" }
  | {
      kind: "rung";
      to: number;
      decimation: Decimation;
      reason: "backpressure" | "headroom";
    };

const HOLD: TickOut = { kind: "hold" };

const median = (v: number[]): number | null =>
  v.length ? [...v].sort((a, b) => a - b)[v.length >> 1]! : null;

// True when the trailing run of bad samples since `from` has lasted 2 s and is still fresh.
function heldFor<T extends { at: number }>(
  xs: T[],
  now: number,
  from: number,
  bad: (x: T) => boolean,
): boolean {
  let since: number | null = null;
  for (const x of xs) if (x.at >= from) since = bad(x) ? (since ?? x.at) : null;
  return (
    since !== null && now - since >= 2000 && now - xs[xs.length - 1]!.at <= 1500
  );
}

/** The latest RTT sample is within 20 percent of the median of the last 5 s. */
export function rttStable(
  xs: { at: number; ms: number }[],
  now: number,
): boolean {
  const recent = xs.filter((x) => now - x.at <= 5000);
  const m = median(recent.map((x) => x.ms));
  return m !== null && Math.abs(recent[recent.length - 1]!.ms - m) <= 0.2 * m;
}

/** One 200 ms tick of 5.6 steps 1 to 4 and 6; step 5 (`stats`) is the caller's. */
export function tick(
  s: LoopState,
  i: TickIn,
): { s: LoopState; out: TickOut; queueMs: number } {
  // Step 1: bytes per second, floored at half the rung's video rate.
  const drain = Math.max(
    i.drainedBytes1s,
    (i.ladder[s.rung]!.video_kbps * 125) / 2,
  );
  const queueMs = (1000 * i.queuedBytes) / drain;
  const n: LoopState = {
    ...s,
    queueSamples: [...s.queueSamples, queueMs].slice(-5),
  };
  // Step 2.
  if (i.now - s.lastKeyframeRequestAt < 300)
    return { s: n, out: HOLD, queueMs };
  // Kernel-buffered bytes: the receive rate or the RTT rule held for 2 s counts as
  // queue_ms > 600; the timers restart after a downshift.
  const med = median(s.rttSamples.map((x) => x.ms));
  const hidden =
    heldFor(
      s.rxSamples,
      i.now,
      s.lastDownAt,
      (x) => x.kbps < 0.8 * i.encodedKbps2s,
    ) ||
    heldFor(
      s.rttSamples,
      i.now,
      s.lastDownAt,
      (x) => med !== null && x.ms > 2 * med,
    );
  n.over600 = queueMs > 600 || hidden ? s.over600 + 1 : 0;
  let out = HOLD;
  if (i.now >= s.overrideUntil) {
    let to = s.rung,
      dec = s.decimation,
      reason: "backpressure" | "headroom" = "backpressure";
    const sinceDown = i.now - s.lastDownAt;
    if (queueMs > 1500 && sinceDown >= 600) {
      // Step 3, emergency.
      to = Math.min(s.rung + 2, 4);
      dec = 2;
    } else if (n.over600 >= 2 && sinceDown >= 1000) {
      to = Math.min(s.rung + 1, 4);
      dec = dec === 0 ? 1 : dec;
    } else if (
      queueMs < 150 &&
      rttStable(s.rttSamples, i.now) &&
      i.now - s.dwellStart > 3000 &&
      i.now - s.lastKeyframeAt > 1000 &&
      s.rung > s.bestRung
    ) {
      to = s.rung - 1;
      dec = 0;
      reason = "headroom";
    }
    n.decimation = dec;
    if (to !== s.rung && s.canChange) {
      // Step 4 applies `out`; any change restarts the dwell.
      n.rung = to;
      n.dwellStart = i.now;
      out = { kind: "rung", to, decimation: dec, reason };
      if (to > s.rung) {
        // A downshift resets the counters.
        n.lastDownAt = i.now;
        n.over600 = 0;
      }
    }
  }
  // Step 6: 15 ticks (3 s) above 1500 ms at the floor rung.
  n.floorTicks =
    n.rung === s.floorRung && queueMs > 1500 ? s.floorTicks + 1 : 0;
  if (n.floorTicks >= 15) out = { kind: "floor_breached" };
  return { s: n, out, queueMs };
}

/**
 * The start rung after the probe (5.6, 6.2.6): the smallest index whose video rate is
 * at most 0.7 x goodput, else rung 4; never better than the server's start rung or
 * the device's best rung.
 */
export function startRung(
  ladder: Rung[],
  goodputKbps: number,
  serverRung: number,
  bestRung: number,
): number {
  const r = ladder.findIndex((x) => x.video_kbps <= 0.7 * goodputKbps);
  return Math.max(r < 0 ? 4 : r, serverRung, bestRung);
}

/**
 * The caller of tick() for one session (6.2.8): counts the bytes handed to the socket,
 * keeps the samples, computes drainedBytes1s = sent(last 1 s) + queued(1 s ago) -
 * queued(now) and encoded_kbps over 2 s, and applies the profile's rules to `keyframe`
 * and `set_rung`.
 */
export class Loop {
  s: LoopState;
  /** queue_ms of the last tick, for `stats`. */
  q = 0;
  /** encoded_kbps over the last 2 s as of the last tick, for `stats` and the loop. */
  kbps = 0;
  // Per tick, newest last, at most 2 s: [bytes sent, media bytes sent, queued bytes].
  private h: number[][] = [];
  private b = [0, 0];

  constructor(
    readonly ladder: Rung[],
    bestRung = 0,
  ) {
    this.s = {
      rung: 0,
      decimation: 0,
      queueSamples: [],
      rttSamples: [],
      rxSamples: [],
      lastKeyframeAt: -Infinity,
      lastKeyframeRequestAt: -Infinity,
      dwellStart: 0,
      lastDownAt: -Infinity,
      over600: 0,
      floorTicks: 0,
      overrideUntil: -Infinity,
      canChange: true,
      floorRung: 4,
      bestRung,
    };
  }

  /**
   * Streaming starts at `rung`; on mediarecorder the rung never changes. Byte counts
   * start here: the probe went out before and has left the socket by `probe_result`.
   */
  begin(rung: number, now: number, canChange: boolean): void {
    Object.assign(this.s, {
      rung,
      dwellStart: now,
      canChange,
      floorRung: canChange ? 4 : rung,
    });
    this.b = [0, 0];
  }

  /** Bytes handed to the socket; `media` for messages of type 0, 1 or 3. */
  count(bytes: number, media: boolean): void {
    this.b[0]! += bytes;
    if (media) this.b[1]! += bytes;
  }

  rtt(ms: number, at: number): void {
    const x = this.s.rttSamples;
    x.push({ at, ms });
    if (x.length > 600) x.shift();
  }

  rx(kbps: number, at: number): void {
    this.s.rxSamples.push({ at, kbps });
  }

  /** A server `keyframe`; ignored on mediarecorder (01 1.5). */
  keyframe(now: number): void {
    if (this.s.canChange) this.s.lastKeyframeRequestAt = now;
  }

  /** An IDR was sent. */
  idr(now: number): void {
    this.s.lastKeyframeAt = now;
  }

  /** A server `set_rung`: overrides the loop for 3 s (5.6); ignored on mediarecorder. */
  set(rung: number, now: number): void {
    if (this.s.canChange)
      Object.assign(this.s, {
        rung,
        dwellStart: now,
        overrideUntil: now + 3000,
      });
  }

  /** One tick with the socket's queued bytes now. */
  run(now: number, queued: number): TickOut {
    const h = this.h;
    h.push([...this.b, queued]);
    this.b = [0, 0];
    if (h.length > 10) h.shift();
    const sum = (n: number, k: number) =>
      h.slice(-n).reduce((a, x) => a + x[k]!, 0);
    this.kbps = (sum(10, 1) * 8) / 2000;
    const r = tick(this.s, {
      now,
      queuedBytes: queued,
      drainedBytes1s: sum(5, 0) + (h[h.length - 6]?.[2] ?? 0) - queued,
      encodedKbps2s: this.kbps,
      ladder: this.ladder,
    });
    this.s = r.s;
    this.q = r.queueMs;
    return r.out;
  }
}
