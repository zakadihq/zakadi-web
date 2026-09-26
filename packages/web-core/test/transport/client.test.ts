import {
  validateClientMsg,
  type AttestMsg,
  type CameraMetaMsg,
  type ClientMsg,
  type ConfigMsg,
  type HelloMsg,
  type ReadyMsg,
  type RungMsg,
  type StatsMsg,
} from "@zakadi/protocol";
import { loadVectors } from "@zakadi/protocol/vectors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, type TransportEvent } from "../../src/transport/client";
import type { IngestCandidate } from "../../src/transport/rank";
import { FakeMedia, FakeSocket, microtaskDigest, type Sent } from "./fakes";
import { sha256 } from "./node";
import {
  fromBase64url,
  readHeader,
  readMessage,
  readProbe,
  toHex,
} from "./read";

// The zakadi.v1 client (spec/06-web-sdk.md 6.2.6, 6.2.7, 6.2.10; spec/05-sdk-contract.md
// 5.6; spec/01-protocol.md 1.1 to 1.5) on the virtual clock, with the messages of the
// pinned protocol's happy-path transcript.
const happy = loadVectors().sessions.find(
  (s) => s.meta.name === "happy-two-actions",
)!;
const msg = <T>(dir: "c2s" | "s2c", t: string): T =>
  structuredClone(
    happy.lines.flatMap((l) =>
      l.dir === dir && "msg" in l && l.msg.t === t ? [l.msg] : [],
    )[0] as T,
  );
const READY = msg<ReadyMsg>("s2c", "ready");
const JTI = fromBase64url(happy.meta.jti);
const A: IngestCandidate = {
  region: "eu-west-2",
  url: "wss://ingest-euw2.zakadi.dev/v1/sessions/ses_01J8VECTOR000000000001/stream",
};
const B: IngestCandidate = {
  region: "af-south-1",
  url: "wss://ingest-afs1.zakadi.dev/v1/sessions/ses_01J8VECTOR000000000001/stream",
};

interface Opts {
  ranked?: IngestCandidate[];
  profile?: "webcodecs" | "mediarecorder";
  maxRung?: number;
}

function start(o: Opts = {}) {
  FakeSocket.all = [];
  const hello = msg<HelloMsg>("c2s", "hello");
  const media = new FakeMedia();
  if (o.profile === "mediarecorder") {
    hello.caps.profile = "mediarecorder";
    media.audio = false;
    media.config = {
      video: { codec: "avc1.42E01F", annexb: false, container: "webm" },
      audio: {
        codec: "opus",
        sample_rate: 48000,
        channels: 1,
        container: "webm",
        muxed_in_video: true,
        echo_cancellation: true,
      },
      clock_source: "aligned",
    };
  }
  const events: TransportEvent[] = [];
  const t = connect({
    WebSocket: FakeSocket,
    ranked: o.ranked ?? [A],
    hello,
    cameraMeta: msg<CameraMetaMsg>("c2s", "camera_meta"),
    jti: JTI,
    media,
    ...(o.maxRung === undefined ? {} : { maxRung: o.maxRung }),
    emit: (e) => events.push(e),
  });
  const sock = () => FakeSocket.all.at(-1)!;
  return { t, hello, media, events, sock };
}

/** Open, ready and probe_result, then `ms` of streaming. */
async function streaming(
  o: Opts = {},
  ms = 100,
  goodput = 640,
  ready: Partial<ReadyMsg> = {},
) {
  const s = start(o);
  s.sock().open();
  s.sock().receive({ ...READY, ...ready });
  s.sock().receive({
    t: "probe_result",
    goodput_kbps: goodput,
    rtt_ms: 190,
    start_rung: 2,
  });
  await vi.advanceTimersByTimeAsync(ms);
  return s;
}

const typeOf = (s: Sent) => (s.bin ? readHeader(s.bin).type : -1);
const isMedia = (s: Sent) => [0, 1, 3].includes(typeOf(s));
/** What was sent, in order: the `t` of each JSON message, `bin<type>` for binaries. */
const kinds = (sent: Sent[]) =>
  sent.map((s) => (s.msg ? s.msg.t : `bin${typeOf(s)}`));

/** The chain over the media messages before index `upto`, recomputed on node:crypto. */
function chainOver(sent: Sent[], upto: number): AttestMsg {
  let h = sha256(new TextEncoder().encode(READY.session_id), JTI);
  let v = 0;
  let a = 0;
  for (const s of sent.slice(0, upto).filter(isMedia)) {
    h = sha256(h, s.bin!);
    const hd = readHeader(s.bin!);
    if (hd.type) a = hd.seq;
    else v = hd.seq;
  }
  return { t: "attest", video_seq: v, audio_seq: a, chain: toHex(h) };
}

beforeEach(() => {
  vi.useFakeTimers();
  microtaskDigest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("candidates and limits", () => {
  it("tries the next candidate when a socket fails before open", async () => {
    const { sock, events } = start({ ranked: [A, B] });
    const first = sock();
    first.fail();
    expect(FakeSocket.all.map((x) => x.url)).toEqual([A.url, B.url]);
    sock().open();
    expect(first.sent).toEqual([]);
    expect(sock().texts()[0]!.t).toBe("hello");
    expect(events[0]).toMatchObject({ k: "open", region: B.region });
  });

  it("ends in network_unavailable when every candidate fails before open", () => {
    const { sock, events } = start({ ranked: [A, B] });
    sock().fail();
    sock().fail();
    expect(FakeSocket.all).toHaveLength(2);
    expect(events).toEqual([{ k: "fatal", code: "network_unavailable" }]);
  });

  it("gives the sockets 8 s in all, then network_unavailable", async () => {
    const { sock, events } = start({ ranked: [A, B] });
    await vi.advanceTimersByTimeAsync(5000);
    sock().fail();
    await vi.advanceTimersByTimeAsync(2999);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual([{ k: "fatal", code: "network_unavailable" }]);
    expect(sock().closedWith).not.toBeNull();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("waits 10 s for ready after hello, then network_unavailable", async () => {
    const { sock, events } = start();
    await vi.advanceTimersByTimeAsync(7000);
    sock().open();
    await vi.advanceTimersByTimeAsync(9999);
    expect(events.filter((e) => e.k === "fatal")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events.filter((e) => e.k === "fatal")).toEqual([
      { k: "fatal", code: "network_unavailable" },
    ]);
    expect(sock().closedWith).not.toBeNull();
  });

  it("never opens a second socket after open", async () => {
    const { sock, events, media } = await streaming({ ranked: [A, B] });
    sock().serverClose(1006);
    await vi.advanceTimersByTimeAsync(20000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(events.at(-1)).toEqual({ k: "closed", code: 1006, reason: "" });
    expect(media.calls.at(-1)).toEqual(["stop"]);
  });
});

describe("the socket and hello", () => {
  it("requests zakadi.v1 with ArrayBuffer binaries and no token in the URL", () => {
    const { sock, hello } = start();
    expect(sock().protocols).toEqual(["zakadi.v1"]);
    expect(sock().binaryType).toBe("arraybuffer");
    expect(sock().url).toBe(A.url);
    expect(sock().url).not.toContain(hello.token.slice(0, 20));
  });

  it("fails protocol_error on another subprotocol without presenting the token", async () => {
    const { sock, events, hello } = start({ ranked: [A, B] });
    sock().open("");
    expect(events).toEqual([{ k: "fatal", code: "protocol_error" }]);
    expect(sock().sent).toEqual([]);
    expect(hello.token).toBe("");
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("sends hello then camera_meta and drops the token after hello", async () => {
    const vector = msg<HelloMsg>("c2s", "hello");
    const { sock, hello, t } = start();
    sock().open();
    expect(sock().texts()).toEqual([
      vector,
      msg<CameraMetaMsg>("c2s", "camera_meta"),
    ]);
    expect(hello.token).toBe("");
    sock().receive(READY);
    sock().receive({
      t: "probe_result",
      goodput_kbps: 640,
      rtt_ms: 190,
      start_rung: 2,
    });
    await vi.advanceTimersByTimeAsync(3000);
    t.send({ t: "bye", reason: "user_cancel" });
    await vi.advanceTimersByTimeAsync(10);
    const later = sock()
      .texts()
      .slice(1)
      .map((m) => JSON.stringify(m));
    expect(later.length).toBeGreaterThan(10);
    expect(later.some((s) => s.includes(vector.token))).toBe(false);
  });
});

describe("probe, start rung and config", () => {
  it("sends the probe burst back to back, then probe_done", () => {
    const { sock } = start();
    sock().open();
    sock().receive(READY);
    const probes = sock().bins(2).map(readMessage);
    expect(probes).toHaveLength(READY.probe.count);
    probes.forEach((p, i) => {
      expect(p.header).toMatchObject({ type: 2, rung: 0, seq: i, pts_ms: 0 });
      expect(p.payload.byteLength + 8).toBe(READY.probe.bytes);
    });
    const times = probes.map((p) => readProbe(p.payload));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(kinds(sock().sent).slice(2)).toEqual([
      ...probes.map(() => "bin2"),
      "probe_done",
    ]);
    expect(sock().texts("probe_done")).toEqual([
      {
        t: "probe_done",
        sent: READY.probe.count,
        bytes: READY.probe.count * READY.probe.bytes,
        first_send_us: times[0],
        last_send_us: times.at(-1),
      },
    ]);
  });

  it.each([
    [640, 2, undefined, 2],
    [2000, 1, undefined, 1],
    [100, 2, undefined, 4],
    [2000, 0, 3, 3],
  ])(
    "starts at the probe's rung: goodput %i, start_rung %i, max_rung %s",
    (g, sr, max, rung) => {
      const { sock, media } = start(max === undefined ? {} : { maxRung: max });
      sock().open();
      sock().receive(READY);
      sock().receive({
        t: "probe_result",
        goodput_kbps: g,
        rtt_ms: 190,
        start_rung: sr,
      });
      expect(media.calls).toEqual([["start", rung]]);
    },
  );

  it("starts at rung 3 when no probe_result arrives in 3 s", async () => {
    const { sock, media } = start();
    sock().open();
    sock().receive(READY);
    await vi.advanceTimersByTimeAsync(2999);
    expect(media.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(media.calls).toEqual([["start", 3]]);
    sock().receive({
      t: "probe_result",
      goodput_kbps: 2000,
      rtt_ms: 190,
      start_rung: 0,
    });
    expect(media.calls).toEqual([["start", 3]]);
  });

  it("sends config before the first media message", async () => {
    const { sock, events } = await streaming();
    const sent = sock().sent;
    const first = sent.findIndex(isMedia);
    expect(sent[first - 1]!.msg).toEqual(msg<ConfigMsg>("c2s", "config"));
    expect(readHeader(sent[first]!.bin!)).toMatchObject({
      type: 0,
      keyframe: true,
      param_sets: true,
      seq: 0,
      pts_ms: 0,
      rung: 2,
    });
    // The audio packet captured before the first frame follows it.
    expect(readHeader(sent[first + 1]!.bin!)).toMatchObject({
      type: 1,
      seq: 0,
      rung: 2,
    });
    expect(events.filter((e) => e.k === "first-media")).toHaveLength(1);
  });
});

describe("rung switches, keyframes and set_rung (6.2.7)", () => {
  // The messages from the first rung message on: rung, config, then the flagged chunk.
  function afterRung(sent: Sent[]) {
    const i = sent.findIndex((s) => s.msg?.t === "rung");
    return {
      i,
      rung: sent[i]!.msg as RungMsg,
      config: sent[i + 1]!.msg as ConfigMsg,
      rest: sent.slice(i + 2),
    };
  }

  it("webcodecs: a loop switch sends rung, config, then the flagged chunk", async () => {
    const { sock, media, events } = await streaming();
    sock().uplink = 0;
    sock().bufferedAmount = 300000;
    await vi.advanceTimersByTimeAsync(400);
    expect(media.calls.slice(1, 2)).toEqual([["apply", 4, 2]]);
    const { i, rung, config, rest } = afterRung(sock().sent);
    const video = rest.findIndex((s) => typeOf(s) === 0);
    const audio = rest.findIndex((s) => isMedia(s) && typeOf(s) !== 0);
    expect(video).toBe(0);
    expect(rung).toMatchObject({ t: "rung", rung: 4, reason: "backpressure" });
    expect(config).toMatchObject({
      t: "config",
      rung: 4,
      video: { w: 288, h: 384, fps: 10, bitrate_kbps: 150 },
      audio: { bitrate_kbps: 12 },
    });
    const v = readHeader(rest[video]!.bin!);
    const a = readMessage(rest[audio]!.bin!);
    expect(v).toMatchObject({
      rung: 4,
      rung_changed: true,
      keyframe: true,
      param_sets: true,
      seq: rung.from_video_seq,
    });
    // At rung 4 audio goes in batches of three, flagged once after the switch.
    expect(a.header).toMatchObject({
      type: 3,
      rung: 4,
      rung_changed: true,
      seq: rung.from_audio_seq,
    });
    expect(a.batch!.map((r) => r.pts_delta_ms)).toEqual([0, 20, 40]);
    const older = sock()
      .sent.slice(0, i)
      .filter(isMedia)
      .map((s) => readHeader(s.bin!));
    expect(older.every((h) => h.rung === 2 && !h.rung_changed)).toBe(true);
    expect(events).toContainEqual({
      k: "rung",
      from: 2,
      to: 4,
      reason: "backpressure",
    });
  });

  it("webcodecs: a keyframe boost sends config at its start and end", async () => {
    const { sock, media, events } = await streaming({}, 1000);
    const from = sock().sent.length;
    sock().receive({
      t: "keyframe",
      id: "k1",
      reason: "apex",
      boost_kbps: 1200,
      boost_ms: 600,
    });
    expect(media.calls.at(-1)).toEqual(["keyframe", 1200, 600]);
    await vi.advanceTimersByTimeAsync(700);
    const sent = sock().sent.slice(from);
    const configs = sent.flatMap((s, i) =>
      s.msg?.t === "config" ? [[i, s] as const] : [],
    );
    expect(
      configs.map(([, s]) => (s.msg as ConfigMsg).video.bitrate_kbps),
    ).toEqual([1200, 400]);
    expect(configs[0]![0]).toBe(0);
    expect(configs[1]![1].at - configs[0]![1].at).toBe(600);
    const key = sent.findIndex((s) => typeOf(s) === 0);
    expect(readHeader(sent[key]!.bin!)).toMatchObject({
      keyframe: true,
      param_sets: true,
      rung: 2,
    });
    expect(key).toBeLessThan(configs[1]![0]);
    expect(events.filter((e) => e.k === "keyframe_request")).toHaveLength(1);
  });

  it("webcodecs: set_rung switches with reason server and holds the loop 3 s", async () => {
    const { sock, media } = await streaming({}, 1000);
    sock().receive({ t: "set_rung", rung: 3, reason: "server_load" });
    expect(media.calls.at(-1)).toEqual(["apply", 3, 0]);
    sock().uplink = 0;
    sock().bufferedAmount = 300000;
    await vi.advanceTimersByTimeAsync(2900);
    expect(media.calls.filter((c) => c[0] === "apply")).toEqual([
      ["apply", 3, 0],
    ]);
    const { rung, config, rest } = afterRung(sock().sent);
    expect(rung).toMatchObject({ rung: 3, reason: "server" });
    expect(config).toMatchObject({
      rung: 3,
      video: { w: 336, h: 448, fps: 12, bitrate_kbps: 250 },
    });
    expect(readHeader(rest[0]!.bin!)).toMatchObject({
      rung: 3,
      rung_changed: true,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(media.calls.at(-1)).toEqual(["apply", 4, 2]);
  });

  it("webcodecs: set_rung to the rung on the wire is answered at once", async () => {
    const { sock, media } = await streaming({}, 500);
    const video = sock().bins(0).length;
    sock().receive({ t: "set_rung", rung: 2, reason: "headroom" });
    expect(sock().sent.at(-1)!.msg).toEqual({
      t: "rung",
      rung: 2,
      reason: "server",
      from_video_seq: video,
      from_audio_seq: sock().bins(1).length,
    });
    expect(media.calls.filter((c) => c[0] === "apply")).toEqual([]);
  });

  it("mediarecorder: keyframe is ignored, set_rung is answered with the unchanged rung, the loop never switches", async () => {
    const { sock, media, events } = await streaming(
      { profile: "mediarecorder" },
      500,
    );
    const from = sock().sent.length;
    sock().receive({
      t: "keyframe",
      id: "k1",
      reason: "apex",
      boost_kbps: 1200,
      boost_ms: 600,
    });
    sock().receive({ t: "set_rung", rung: 4, reason: "server_load" });
    expect(
      sock()
        .sent.slice(from)
        .map((s) => s.msg),
    ).toEqual([
      {
        t: "rung",
        rung: 2,
        reason: "server",
        from_video_seq: sock().bins(0).length,
        from_audio_seq: 0,
      },
    ]);
    sock().uplink = 0;
    sock().bufferedAmount = 300000;
    await vi.advanceTimersByTimeAsync(2800);
    expect(media.calls).toEqual([["start", 2]]);
    expect(sock().texts("config")).toHaveLength(1);
    expect(sock().texts("config")[0]).toMatchObject({
      video: { container: "webm", annexb: false, bitrate_kbps: 400 },
      audio: { container: "webm" },
      clock_source: "aligned",
    });
    // 3 s above 1500 ms at the recorder's rung ends the session (5.6).
    await vi.advanceTimersByTimeAsync(400);
    expect(sock().texts().at(-1)).toEqual({
      t: "bye",
      reason: "floor_breached",
    });
    expect(events).toContainEqual({ k: "fatal", code: "network_floor" });
  });
});

describe("stats, pongs, pings, audio_batch, attest, bye and the media limit", () => {
  it("sends stats every stats_interval_ms while streaming", async () => {
    const { sock, media } = await streaming({}, 0);
    media.counts = {
      enc_queue: 2,
      pre_encode_drops: 3,
      captured_fps: 14.5,
      battery_low: true,
    };
    sock().uplink = 0;
    sock().bufferedAmount = 5000;
    const from = sock().sent.length;
    const t0 = performance.now();
    await vi.advanceTimersByTimeAsync(2050);
    const sent = sock().sent;
    const stats = sent.filter((s) => s.msg?.t === "stats");
    expect(stats.map((s) => s.at - t0)).toEqual([500, 1000, 1500, 2000]);
    for (const s of stats) expect(validateClientMsg(s.msg)).toBe(true);
    const first = stats[0]!.msg as StatsMsg;
    expect(Object.keys(first).sort()).toEqual([
      "battery_low",
      "captured_fps",
      "enc_queue",
      "encoded_kbps",
      "pre_encode_drops",
      "queue_ms",
      "queued_bytes",
      "rtt_ms",
      "t",
    ]);
    expect(first).toMatchObject({
      enc_queue: 2,
      pre_encode_drops: 3,
      captured_fps: 14.5,
      battery_low: true,
      rtt_ms: 190,
    });
    // Nothing drains: queued_bytes is the scripted 5000 plus everything sent since.
    const size = (s: Sent) =>
      s.bin ? s.bin.byteLength : JSON.stringify(s.msg).length;
    const before = sent.slice(from, sent.indexOf(stats[0]!));
    expect(first.queued_bytes).toBe(
      5000 + before.reduce((n, s) => n + size(s), 0),
    );
    expect(first.queue_ms).toBeGreaterThan(0);
    // encoded_kbps: media headers and payloads over 2 s, as of the last tick (400 ms).
    const media400 = before.filter((s) => isMedia(s) && s.at - t0 <= 400);
    expect(first.encoded_kbps).toBe(
      Math.round((media400.reduce((n, s) => n + size(s), 0) * 8) / 2000),
    );
  });

  it("answers a server ping at once and takes its rtt_ms", async () => {
    const { sock, media } = await streaming({}, 1000);
    const t = performance.now();
    sock().receive({
      t: "ping",
      id: "p9",
      server_ms: 5000,
      rtt_ms: 180.4,
      rx_kbps: 400,
    });
    expect(sock().sent.at(-1)).toEqual({
      at: t,
      msg: { t: "pong", re: "p9", at_ms: Math.floor(t - media.origin()!) },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect((sock().texts("stats").at(-1) as StatsMsg).rtt_ms).toBe(180);
  });

  it("answers ping with at_ms 0 before the first frame", () => {
    const { sock } = start();
    sock().open();
    sock().receive({
      t: "ping",
      id: "p1",
      server_ms: 0,
      rtt_ms: null,
      rx_kbps: null,
    });
    expect(sock().texts().at(-1)).toEqual({ t: "pong", re: "p1", at_ms: 0 });
  });

  it("pings once a second while no server rtt_ms arrived in the last 2 s", async () => {
    const { sock } = await streaming({}, 0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      sock()
        .texts("ping")
        .map((m) => (m as { id: string }).id),
    ).toEqual(["c1", "c2"]);
    // The matching pong is an RTT sample.
    await vi.advanceTimersByTimeAsync(40);
    sock().receive({ t: "pong", re: "c2", server_ms: 9000 });
    await vi.advanceTimersByTimeAsync(460);
    expect((sock().texts("stats").at(-1) as StatsMsg).rtt_ms).toBe(40);
    // A server rtt_ms holds the own pings for 2 s.
    sock().receive({
      t: "ping",
      id: "p2",
      server_ms: 9000,
      rtt_ms: 150,
      rx_kbps: 400,
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(sock().texts("ping")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1001);
    expect(sock().texts("ping")).toHaveLength(3);
  });

  it("batches audio three packets a message at rungs 3 and 4 only", async () => {
    const low = await streaming({}, 1000, 300);
    const batches = low.sock().bins(3).map(readMessage);
    expect(low.sock().bins(1)).toEqual([]);
    expect(batches.length).toBeGreaterThan(10);
    batches.forEach((b, i) => expect(b.header.seq).toBe(i));
    // The first batch holds the packets captured before the first frame, at pts 0.
    for (const b of batches.slice(1))
      expect(b.batch!.map((r) => r.pts_delta_ms)).toEqual([0, 20, 40]);
    const high = await streaming({}, 1000, 640);
    expect(high.sock().bins(3)).toEqual([]);
    expect(high.sock().bins(1).length).toBeGreaterThan(40);
  });

  it("attests each time the video pts crosses attest_interval_ms, over what was sent", async () => {
    const { sock } = await streaming({}, 3100);
    const sent = sock().sent;
    const at = sent.flatMap((s, i) => (s.msg?.t === "attest" ? [i] : []));
    expect(at).toHaveLength(3);
    for (const i of at) {
      const before = sent
        .slice(0, i)
        .filter((s) => typeOf(s) === 0)
        .map((s) => readHeader(s.bin!).pts_ms);
      const crossed = before.findIndex((p) => p >= 1000 * (at.indexOf(i) + 1));
      expect(crossed).toBeGreaterThan(0);
      expect(sent[i]!.msg).toEqual(chainOver(sent, i));
    }
  });

  it("attests once more immediately before bye, and nothing follows", async () => {
    const { sock, t, media } = await streaming({}, 1500);
    t.send({ t: "bye", reason: "user_cancel" });
    await vi.advanceTimersByTimeAsync(1000);
    const sent = sock().sent;
    expect(kinds(sent).slice(-2)).toEqual(["attest", "bye"]);
    expect(sent.at(-2)!.msg).toEqual(chainOver(sent, sent.length - 2));
    expect(media.calls.at(-1)).toEqual(["stop"]);
  });

  it("attests once more after end while the socket is open", async () => {
    const { sock, media, events } = await streaming({}, 1500);
    sock().receive({
      t: "end",
      outcome: "completed",
      reason: "ok",
      retry: false,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const sent = sock().sent;
    expect(kinds(sent).at(-1)).toBe("attest");
    expect(sent.at(-1)!.msg).toEqual(chainOver(sent, sent.length - 1));
    expect(kinds(sent)).not.toContain("bye");
    expect(media.calls.at(-1)).toEqual(["stop"]);
    expect(events).toContainEqual({
      k: "server",
      msg: { t: "end", outcome: "completed", reason: "ok", retry: false },
    });
  });

  it("sends bye floor_breached after 15 ticks above 1500 ms at rung 4 (5.6 step 6)", async () => {
    const { sock, media, events } = await streaming({ maxRung: 4 }, 100);
    sock().uplink = 0;
    sock().bufferedAmount = 300000;
    await vi.advanceTimersByTimeAsync(2799);
    expect(sock().texts("bye")).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(kinds(sock().sent).slice(-2)).toEqual(["attest", "bye"]);
    expect(sock().texts().at(-1)).toEqual({
      t: "bye",
      reason: "floor_breached",
    });
    expect(media.calls.at(-1)).toEqual(["stop"]);
    expect(events.at(-1)).toEqual({ k: "fatal", code: "network_floor" });
    // The socket stays open for end and the close.
    sock().receive({
      t: "end",
      outcome: "aborted",
      reason: "floor_breached",
      retry: true,
    });
    sock().serverClose(1000);
    expect(events.slice(-2)).toEqual([
      {
        k: "server",
        msg: {
          t: "end",
          outcome: "aborted",
          reason: "floor_breached",
          retry: true,
        },
      },
      { k: "closed", code: 1000, reason: "" },
    ]);
  });

  it("stops the media at max_media_ms - 500", async () => {
    const { sock, media } = await streaming({}, 3000, 640, {
      max_media_ms: 2000,
    });
    const stop = media.calls.findIndex((c) => c[0] === "stop");
    expect(stop).toBeGreaterThan(0);
    const pts = sock()
      .bins(0)
      .map((b) => readHeader(b).pts_ms);
    expect(pts.filter((p) => p >= 1500)).toHaveLength(1);
    expect(Math.max(...pts)).toBeLessThan(1500 + 1000 / 15);
  });

  it("forwards the session's messages and keeps ping, pong, keyframe and set_rung", async () => {
    const { sock, events } = await streaming({}, 100);
    const n = events.length;
    const ui = msg<ClientMsg>("s2c", "ui");
    sock().receive(ui);
    sock().receive({
      t: "ping",
      id: "p5",
      server_ms: 1,
      rtt_ms: null,
      rx_kbps: null,
    });
    sock().receive({ t: "future_type", x: 1 });
    sock().receive({ t: "tile", symbol: 5, min_ms: 400 });
    expect(events.slice(n)).toEqual([
      { k: "server", msg: ui },
      { k: "server", msg: { t: "tile", symbol: 5, min_ms: 400 } },
    ]);
  });
});

describe("every message the client sends", () => {
  it("passes validateClientMsg", async () => {
    const { sock, t } = await streaming({}, 1500, 300);
    sock().receive({
      t: "keyframe",
      id: "k1",
      reason: "apex",
      boost_kbps: 1200,
      boost_ms: 600,
    });
    sock().receive({ t: "set_rung", rung: 2, reason: "headroom" });
    sock().receive({
      t: "ping",
      id: "p5",
      server_ms: 1,
      rtt_ms: 190,
      rx_kbps: 300,
    });
    await vi.advanceTimersByTimeAsync(2000);
    t.send({ t: "audio_state", re: "s1", event: "started", at_ms: 10 });
    t.send({ t: "bye", reason: "user_cancel" });
    await vi.advanceTimersByTimeAsync(10);
    const texts = sock().texts();
    expect(new Set(texts.map((m) => m.t))).toEqual(
      new Set([
        "hello",
        "camera_meta",
        "probe_done",
        "config",
        "stats",
        "attest",
        "pong",
        "rung",
        "ping",
        "audio_state",
        "bye",
      ]),
    );
    for (const m of texts)
      expect(
        validateClientMsg(m),
        JSON.stringify(validateClientMsg.errors),
      ).toBe(true);
  });
});
