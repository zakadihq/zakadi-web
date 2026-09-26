import type { ReadyMsg } from "@zakadi/protocol";
import { loadVectors } from "@zakadi/protocol/vectors";
import { describe, expect, it } from "vitest";
import { Loop, rttStable, startRung, tick } from "../../src/control/loop";

// The control-loop simulation of spec/05-sdk-contract.md 5.16: until vectors/loop/ ships
// (D95), traces/*.json are this SDK's fixtures, derived by hand from 5.6. Each trace
// gives, per 200 ms tick, the bytes handed to the socket and its queued bytes, plus RTT,
// receive-rate, keyframe, IDR and set_rung events; tick() must yield its rung sequence,
// its floor breach and the queue_ms its stats report.

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
        readdirSync(p: URL): string[];
        readFileSync(p: URL, enc: "utf8"): string;
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

describe("loop traces (5.6)", () => {
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
