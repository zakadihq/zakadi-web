import {
  validateClientMsg,
  type CameraMetaMsg,
  type ClientMsg,
  type ClientPongMsg,
  type HelloMsg,
  type KeyframeMsg,
} from "@zakadi/protocol";
import {
  loadVectors,
  schemasDir,
  type Transcript,
} from "@zakadi/protocol/vectors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, type TransportEvent } from "../../src/transport/client";
import { FakeMedia, FakeSocket, microtaskDigest, type Sent } from "./fakes";
import { builtin } from "./node";
import { fromBase64url, readHeader } from "./read";

// The fake-server replay of spec/05-sdk-contract.md 5.16 and spec/06-web-sdk.md 6.11:
// the server side of each sessions/*.jsonl is replayed at its recorded offsets on the
// virtual clock (t 0 is hello), the session's own messages (audio_state, ui_event and a
// user's bye) are sent through the client at theirs, and the client's control messages
// are checked by type, order and required fields, with tolerance on time fields and
// measurements.
//
// The transcripts are hand-authored and summarise periodic traffic, so the client may
// send, between the transcript's messages: stats, attest and own pings (sampled or
// absent in the transcripts); the config pair of a keyframe boost (6.2.7 step 3, G2),
// at the boost's start and end; and, in protocol-error, whose recorded client streamed
// before any probe, the probe's probe_done. `stats` lines are counted, not matched. A
// pong is placed by its ping, which it answers at once: the client probes as soon as
// `ready` arrives (5.6), before the ping the transcripts answer first.
const sessions = loadVectors().sessions;
const fs = builtin<{ readFileSync(p: string, enc: "utf8"): string }>("node:fs");
const required = (t: string): string[] =>
  JSON.parse(
    fs.readFileSync(`${schemasDir()}/v1/client/${t}.schema.json`, "utf8"),
  ).required;

/** Fields compared by value; every other required field only has to be present. */
const SAME: Record<string, string[]> = {
  hello: ["v", "token", "sdk", "caps", "prompt_pack", "a11y", "consent"],
  pong: ["re"],
  probe_done: ["sent", "bytes"],
  config: ["video", "audio", "rung", "clock_source"],
  rung: ["rung", "reason"],
  audio_state: ["re", "event", "at_ms"],
  ui_event: ["event", "detail", "at_ms"],
  bye: ["reason"],
};

/** The uplink each transcript implies: floor-breached's collapses to 64 kbps at 600 ms. */
const UPLINK: Record<string, [number, number][]> = {
  "floor-breached": [[600, 8000]],
};

const fromSession = (m: ClientMsg) =>
  m.t === "audio_state" ||
  m.t === "ui_event" ||
  (m.t === "bye" && m.reason !== "floor_breached");

function run(tr: Transcript) {
  FakeSocket.all = [];
  const c2s = tr.lines.flatMap((l) =>
    l.dir === "c2s" && "msg" in l ? [l.msg] : [],
  );
  const s2c = tr.lines.filter((l) => l.dir === "s2c");
  const hello = structuredClone(c2s.find((m) => m.t === "hello") as HelloMsg);
  // admission-rejected and protocol-error end before camera_meta; the SDK sends its own.
  const cameraMeta = structuredClone(
    (c2s.find((m) => m.t === "camera_meta") ??
      sessions
        .flatMap((s) => s.lines)
        .flatMap((l) =>
          "msg" in l && l.msg.t === "camera_meta" ? [l.msg] : [],
        )[0]) as CameraMetaMsg,
  );
  const media = new FakeMedia();
  const events: TransportEvent[] = [];
  // The transcripts never step above their start rung: the device's best rung is 2.
  const t = connect({
    WebSocket: FakeSocket,
    ranked: [
      {
        region: "eu-west-2",
        url: `wss://ingest-euw2.zakadi.dev/v1/sessions/${tr.meta.session_id}/stream`,
      },
    ],
    hello,
    cameraMeta,
    jti: fromBase64url(tr.meta.jti),
    media,
    maxRung: 2,
    emit: (e) => events.push(e),
  });
  const sock = FakeSocket.all[0]!;
  const t0 = performance.now();
  sock.open();
  for (const [at, rate] of UPLINK[tr.meta.name] ?? [])
    setTimeout(() => (sock.uplink = rate), at);
  for (const l of tr.lines) {
    if ("close" in l)
      setTimeout(
        () => sock.serverClose(l.close.code, l.close.reason ?? ""),
        l.t_ms,
      );
    else if ("msg" in l && l.dir === "s2c")
      setTimeout(() => sock.receive(l.msg), l.t_ms);
    else if ("msg" in l && fromSession(l.msg))
      setTimeout(() => t.send(l.msg as never), l.t_ms);
  }
  const boosts = s2c.flatMap((l) =>
    "msg" in l && l.msg.t === "keyframe" && (l.msg as KeyframeMsg).boost_ms
      ? [l.t_ms, l.t_ms + (l.msg as KeyframeMsg).boost_ms!]
      : [],
  );
  return { sock, events, t0, c2s, s2c, boosts, end: tr.lines.at(-1)!.t_ms };
}

// JSON with sorted keys, so that field order does not matter.
const canon = (v: unknown): string =>
  v && typeof v === "object" && !Array.isArray(v)
    ? `{${Object.keys(v)
        .sort()
        .map((k) => `${k}:${canon((v as Record<string, unknown>)[k])}`)
        .join(",")}}`
    : Array.isArray(v)
      ? `[${v.map(canon).join(",")}]`
      : JSON.stringify(v);
const pick = (m: object, keys: string[]) =>
  Object.fromEntries(
    keys
      .filter((k) => k in m)
      .map((k) => [k, (m as Record<string, unknown>)[k]]),
  );

function matches(e: ClientMsg, a: ClientMsg): boolean {
  if (e.t !== a.t) return false;
  if (!required(a.t).every((k) => k in a)) return false;
  const keys = SAME[e.t] ?? [];
  return canon(pick(e, keys)) === canon(pick(a, keys));
}

beforeEach(() => {
  vi.useFakeTimers();
  microtaskDigest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(sessions)("replaying $meta.name", (tr) => {
  it("yields its client control messages, camera_meta before media, and its end or close", async () => {
    const r = run(tr);
    await vi.advanceTimersByTimeAsync(r.end + 1000);
    const sent = r.sock.sent;
    const texts = sent.flatMap((s) => (s.msg ? [s] : []));

    // Every message passes the pinned schemas.
    for (const s of texts)
      expect(validateClientMsg(s.msg), JSON.stringify(s.msg)).toBe(true);

    // hello first, camera_meta exactly once and before the first media message.
    expect(texts[0]!.msg).toEqual(r.c2s[0]);
    const cm = sent.flatMap((s, i) => (s.msg?.t === "camera_meta" ? [i] : []));
    const firstMedia = sent.findIndex(
      (s) => s.bin && readHeader(s.bin).type !== 2,
    );
    expect(cm).toHaveLength(1);
    if (firstMedia >= 0) expect(cm[0]).toBeLessThan(firstMedia);

    // Each ping answered at once, in the transcript's order.
    const pongs = texts.filter((s) => s.msg!.t === "pong");
    expect(
      pongs.map((s) => [s.at - r.t0, (s.msg as ClientPongMsg).re]),
    ).toEqual(
      r.s2c.flatMap((l) =>
        "msg" in l && l.msg.t === "ping" ? [[l.t_ms, l.msg.id]] : [],
      ),
    );
    for (const s of pongs)
      expect(required("pong").every((k) => k in s.msg!)).toBe(true);
    expect(pongs.map((s) => (s.msg as ClientPongMsg).re)).toEqual(
      r.c2s.flatMap((m) => (m.t === "pong" ? [m.re] : [])),
    );

    // The transcript's other messages in order, by type and required fields.
    const skip = ["camera_meta", "stats", "pong"];
    const expected = r.c2s.filter((m) => !skip.includes(m.t));
    const actual = texts.filter(
      (s) => s.msg!.t !== "camera_meta" && s.msg!.t !== "pong",
    );
    const extra = (s: Sent) =>
      ["stats", "attest", "ping"].includes(s.msg!.t) ||
      (s.msg!.t === "config" && r.boosts.includes(s.at - r.t0)) ||
      (s.msg!.t === "probe_done" && tr.meta.name === "protocol-error");
    let j = 0;
    for (const e of expected) {
      while (j < actual.length && !matches(e, actual[j]!.msg!)) {
        expect(
          extra(actual[j]!),
          `${actual[j]!.msg!.t} at ${actual[j]!.at - r.t0} ms, before ${e.t}`,
        ).toBe(true);
        j++;
      }
      expect(j, `no ${JSON.stringify(e)}`).toBeLessThan(actual.length);
      j++;
    }
    for (const s of actual.slice(j))
      expect(extra(s), `${s.msg!.t} after the last expected message`).toBe(
        true,
      );
    // The final attest immediately before bye.
    const bye = texts.findIndex((s) => s.msg!.t === "bye");
    if (bye >= 0) expect(texts[bye - 1]!.msg!.t).toBe("attest");
    expect(texts.filter((s) => s.msg!.t === "bye")).toHaveLength(
      r.c2s.filter((m) => m.t === "bye").length,
    );
    expect(
      texts.filter((s) => s.msg!.t === "stats").length,
    ).toBeGreaterThanOrEqual(r.c2s.filter((m) => m.t === "stats").length);

    // The end or the close, and any error, reach the session.
    for (const l of r.s2c)
      if ("msg" in l && (l.msg.t === "end" || l.msg.t === "error"))
        expect(r.events).toContainEqual({ k: "server", msg: l.msg });
    const close = r.s2c.find((l) => "close" in l);
    if (close && "close" in close)
      expect(r.events.at(-1)).toEqual({
        k: "closed",
        code: close.close.code,
        reason: close.close.reason ?? "",
      });
    const rungs = tr.meta.expect?.["rungs"] as number[] | undefined;
    if (rungs)
      expect([
        2,
        ...r.events.flatMap((e) => (e.k === "rung" ? [e.to] : [])),
      ]).toEqual(rungs);
  });
});
