import type { ReadyMsg } from "@zakadi/protocol";
import { loadVectors, vectorsDir } from "@zakadi/protocol/vectors";
import { describe, expect, it } from "vitest";
import {
  Loop,
  rttStable,
  startRung,
  tick,
  type Rung,
  type TickOut,
} from "../../src/control/loop";

// The control-loop simulation of spec/05-sdk-contract.md 5.16 and spec/06-web-sdk.md
// 6.11. Each vectors/loop/*.json of @zakadi/protocol@0.2.1 (01 1.12) goes through tick()
// and the loop's event methods and must yield its rung and decimation changes and its
// floor tick. traces/*.json, this SDK's own fixtures from before those shipped (D95),
// cover the caller, which the vectors leave out: each gives, per 200 ms tick, the bytes
// handed to the socket and its queued bytes, plus RTT, receive-rate, keyframe, IDR and
// set_rung events, and Loop must yield, from the drainedBytes1s and encoded rate it
// computes, the trace's rung sequence, its floor breach and the queue_ms its stats report.

/** A vectors/loop/*.json trace (schemas/v1/loop-trace.schema.json of the package). */
interface LoopVector {
  name: string;
  profile: "webcodecs" | "native" | "mediarecorder";
  ladder: Rung[];
  start_rung: number;
  ticks: {
    t_ms: number;
    queued_bytes: number;
    drained_bytes_1s: number;
    encoded_kbps_2s: number;
  }[];
  pings: { t_ms: number; rtt_ms: number | null; rx_kbps: number | null }[];
  set_rung: { t_ms: number; rung: number }[];
  keyframe_requests: { t_ms: number }[];
  idrs: { t_ms: number }[];
  expect: {
    rungs: { t_ms: number; rung: number; reason: string }[];
    decimation: { t_ms: number; decimation: number }[];
    floor_tick: number | null;
  };
}

interface Trace {
  name: string;
  profile: "webcodecs" | "mediarecorder";
  covers: number[];
  start: number;
  best?: number;
  until: number;
  /** [from_ms, value] pieces, constant until the next piece. */
  sent: [number, number][];
  media: [number, number][];
  queued: [number, number][];
  /** [at_ms, kind, value?, every_ms?, until_ms?]; a repeated event recurs until until_ms. */
  events: [number, string, number?, number?, number?][];
  stats_interval_ms?: number;
  expect: {
    rungs: [number, number, number, string][];
    floor: number | null;
    stats?: [number, number, number][];
  };
}

// node:fs, typed here: the workspace has no @types/node.
const fs = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: "node:fs"): {
        readdirSync(p: string | URL): string[];
        readFileSync(p: string | URL, enc: "utf8"): string;
      };
    };
  }
).process.getBuiltinModule("node:fs");
const dir = new URL("./traces/", import.meta.url);
const traces: Trace[] = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(new URL(f, dir), "utf8")));
const vdir = `${vectorsDir()}/loop`;
const vectors: LoopVector[] = fs
  .readdirSync(vdir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(`${vdir}/${f}`, "utf8")));

// The ladder of the pinned protocol's `ready` (01 1.5).
const ready = loadVectors()
  .sessions.flatMap((s) => s.lines)
  .find((l) => "msg" in l && l.msg.t === "ready") as { msg: ReadyMsg };
const ladder = ready.msg.ladder;

const at = (pieces: [number, number][], t: number) =>
  pieces.filter(([from]) => from <= t).at(-1)![1];

function replay(tr: Trace) {
  const loop = new Loop(ladder, tr.best ?? 0);
  loop.begin(tr.start, 0, tr.profile === "webcodecs");
  const events = tr.events
    .flatMap(([t, kind, value, every, until]) => {
      const out: { at: number; kind: string; value: number }[] = [];
      for (let a = t; a <= (every ? until! : t); a += every ?? 1)
        out.push({ at: a, kind, value: value ?? 0 });
      return out;
    })
    .sort((a, b) => a.at - b.at);
  const rungs: [number, number, number, string][] = [];
  const stats: [number, number, number][] = [];
  let floor: number | null = null;
  let e = 0;
  for (let t = 200; t <= tr.until; t += 200) {
    for (; e < events.length && events[e]!.at <= t; e++) {
      const ev = events[e]!;
      if (ev.kind === "rtt") loop.rtt(ev.value, ev.at);
      else if (ev.kind === "rx") loop.rx(ev.value, ev.at);
      else if (ev.kind === "keyframe") loop.keyframe(ev.at);
      else if (ev.kind === "idr") loop.idr(ev.at);
      else if (ev.kind === "set") {
        const before = loop.s.rung;
        loop.set(ev.value, ev.at);
        if (loop.s.rung !== before)
          rungs.push([ev.at, loop.s.rung, loop.s.decimation, "server"]);
      } else throw new Error(`${tr.name}: unknown event ${ev.kind}`);
    }
    const media = at(tr.media, t);
    loop.count(at(tr.sent, t) - media, false);
    loop.count(media, true);
    const out = loop.run(t, at(tr.queued, t));
    if (out.kind === "rung")
      rungs.push([t, out.to, out.decimation, out.reason]);
    if (out.kind === "floor_breached") {
      floor = t;
      break;
    }
    // Step 5: stats every stats_interval_ms carry the last tick's queue_ms.
    const iv = tr.stats_interval_ms;
    if (iv)
      for (
        let s = Math.ceil(t / iv) * iv;
        s < t + 200 && s <= tr.until;
        s += iv
      )
        stats.push([s, Math.round(loop.q), Math.round(loop.kbps)]);
  }
  return { rungs, floor, stats };
}

/**
 * A vector's inputs in t_ms order, any other input before a tick at the same t_ms,
 * until the floor breaches or the ticks end (01 1.12). A native trace runs as webcodecs
 * does: only mediarecorder's rung cannot change.
 */
function replayVector(v: LoopVector): LoopVector["expect"] {
  const loop = new Loop(v.ladder);
  loop.begin(v.start_rung, 0, v.profile !== "mediarecorder");
  const got: LoopVector["expect"] = {
    rungs: [],
    decimation: [],
    floor_tick: null,
  };
  const inputs: { at: number; tick: boolean; run(): TickOut | void }[] = [
    ...v.pings.map((p) => ({
      at: p.t_ms,
      tick: false,
      run() {
        if (p.rtt_ms !== null) loop.rtt(p.rtt_ms, p.t_ms);
        if (p.rx_kbps !== null) loop.rx(p.rx_kbps, p.t_ms);
      },
    })),
    ...v.keyframe_requests.map((k) => ({
      at: k.t_ms,
      tick: false,
      run: () => loop.keyframe(k.t_ms),
    })),
    ...v.idrs.map((k) => ({
      at: k.t_ms,
      tick: false,
      run: () => loop.idr(k.t_ms),
    })),
    ...v.set_rung.map((m) => ({
      at: m.t_ms,
      tick: false,
      run() {
        // Answered with `rung`, on mediarecorder the unchanged one (5.6, D143).
        loop.set(m.rung, m.t_ms);
        got.rungs.push({ t_ms: m.t_ms, rung: loop.s.rung, reason: "server" });
      },
    })),
    ...v.ticks.map((k) => ({
      at: k.t_ms,
      tick: true,
      run() {
        const r = tick(loop.s, {
          now: k.t_ms,
          queuedBytes: k.queued_bytes,
          drainedBytes1s: k.drained_bytes_1s,
          encodedKbps2s: k.encoded_kbps_2s,
          ladder: v.ladder,
        });
        loop.s = r.s;
        return r.out;
      },
    })),
  ];
  inputs.sort((a, b) => a.at - b.at || Number(a.tick) - Number(b.tick));
  for (const input of inputs) {
    const dec = loop.s.decimation;
    const out = input.run();
    if (loop.s.decimation !== dec)
      got.decimation.push({ t_ms: input.at, decimation: loop.s.decimation });
    if (out?.kind === "rung")
      got.rungs.push({ t_ms: input.at, rung: out.to, reason: out.reason });
    if (out?.kind === "floor_breached") {
      got.floor_tick = input.at;
      break;
    }
  }
  return got;
}

describe("vectors/loop of @zakadi/protocol (5.6, 5.16)", () => {
  it("are the ten traces of 0.2.1", () => {
    expect(vectors).toHaveLength(10);
  });

  it.each(vectors)(
    "$name yields its rung and decimation changes and floor tick",
    (v) => {
      expect(replayVector(v)).toEqual(v.expect);
    },
  );
});

describe("the SDK's own traces (5.6, D95)", () => {
  it("cover steps 1 to 6 on both profiles", () => {
    for (const profile of ["webcodecs", "mediarecorder"]) {
      const steps = new Set(
        traces.filter((t) => t.profile === profile).flatMap((t) => t.covers),
      );
      expect([...steps].sort(), profile).toEqual([1, 2, 3, 4, 5, 6]);
    }
  });

  it.each(traces)("$name yields its rung sequence", (tr) => {
    const r = replay(tr);
    expect(r.rungs).toEqual(tr.expect.rungs);
    expect(r.floor).toBe(tr.expect.floor);
    if (tr.expect.stats) expect(r.stats).toEqual(tr.expect.stats);
  });
});

describe("tick()", () => {
  const base = () => new Loop(ladder).s;

  it("skips the tick within 300 ms of a keyframe request", () => {
    const s = { ...base(), rung: 2, lastKeyframeRequestAt: 1000 };
    const i = {
      now: 1250,
      queuedBytes: 1e6,
      drainedBytes1s: 0,
      encodedKbps2s: 0,
      ladder,
    };
    expect(tick(s, i).out).toEqual({ kind: "hold" });
    expect(tick(s, { ...i, now: 1300 }).out).toMatchObject({
      kind: "rung",
      to: 4,
    });
  });

  it("keeps the last five queue samples", () => {
    let s = { ...base(), rung: 2 };
    for (let k = 1; k <= 7; k++)
      s = tick(s, {
        now: k * 200,
        queuedBytes: k * 1000,
        drainedBytes1s: 1e5,
        encodedKbps2s: 0,
        ladder,
      }).s;
    expect(s.queueSamples).toEqual([30, 40, 50, 60, 70]);
  });

  it("compares the latest RTT with the median of the last 5 s", () => {
    const xs = [100, 100, 110, 140].map((ms, k) => ({ at: k * 1000, ms }));
    expect(rttStable(xs.slice(0, 3), 2000)).toBe(true);
    expect(rttStable(xs, 3000)).toBe(false);
    expect(rttStable(xs, 9000)).toBe(false);
  });

  it("needs three RTT samples in the last 5 s (D132)", () => {
    const xs = [0, 1000, 2000, 6500].map((at) => ({ at, ms: 100 }));
    expect(rttStable(xs.slice(0, 1), 0)).toBe(false);
    expect(rttStable(xs.slice(0, 2), 1000)).toBe(false);
    expect(rttStable(xs.slice(0, 3), 2000)).toBe(true);
    // Four in the session, two of them in the last 5 s.
    expect(rttStable(xs, 6500)).toBe(false);
  });

  it("breaches the floor on the 15th tick after the step down to rung 4 (D130)", () => {
    let s = { ...base(), rung: 2 };
    const step = (now: number) => {
      const r = tick(s, {
        now,
        queuedBytes: 1e6,
        drainedBytes1s: 0,
        encodedKbps2s: 0,
        ladder,
      });
      s = r.s;
      return r.out;
    };
    expect(step(200)).toMatchObject({ kind: "rung", to: 4 });
    for (let k = 1; k < 15; k++)
      expect(step(200 + k * 200)).toEqual({ kind: "hold" });
    expect(step(3200)).toEqual({ kind: "floor_breached" });
  });
});

describe("Loop.set()", () => {
  it("clears the decimation on a server upshift and keeps it on a downshift (D132)", () => {
    const loop = new Loop(ladder);
    loop.begin(2, 0, true);
    loop.s.decimation = 1;
    loop.set(3, 1000);
    expect(loop.s).toMatchObject({
      rung: 3,
      decimation: 1,
      overrideUntil: 4000,
    });
    loop.set(1, 1500);
    expect(loop.s).toMatchObject({
      rung: 1,
      decimation: 0,
      overrideUntil: 4500,
    });
  });
});

describe("startRung()", () => {
  it.each([
    [640, 2, 0, 2],
    [2000, 2, 0, 2],
    [2000, 0, 0, 0],
    [1000, 1, 0, 1],
    [100, 0, 0, 4],
    [2000, 0, 3, 3],
  ])(
    "goodput %i kbps, server rung %i, best %i: rung %i",
    (g, server, best, r) => {
      expect(startRung(ladder, g, server, best)).toBe(r);
    },
  );
});
