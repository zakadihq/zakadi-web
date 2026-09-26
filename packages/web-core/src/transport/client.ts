import {
  ZAKADI_SUBPROTOCOL,
  type ActionMsg,
  type AudioStateMsg,
  type ByeMsg,
  type CameraMetaMsg,
  type ClientMsg,
  type EndMsg,
  type ErrorCode,
  type ErrorMsg,
  type FeedbackMsg,
  type HelloMsg,
  type ProbeResultMsg,
  type ReadyMsg,
  type RungMsg,
  type SayMsg,
  type ServerMsg,
  type StatsMsg,
  type TileMsg,
  type UiEventMsg,
  type UiMsg,
} from "@zakadi/protocol";
import { Loop, startRung, type Decimation } from "../control/loop";
import { Chain } from "./chain";
import { AUDIO, pack, packBatch, packProbe, VIDEO } from "./framing";
import type { Chunk, Media, MediaConfig } from "./media";
import type { IngestCandidate } from "./rank";

/** The part of WebSocket the client uses. */
export interface Socket {
  readonly protocol: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

/** The server messages the session handles; ping, pong, keyframe and set_rung stay here. */
export type SessionMsg =
  | ReadyMsg
  | ProbeResultMsg
  | UiMsg
  | SayMsg
  | ActionMsg
  | TileMsg
  | FeedbackMsg
  | EndMsg
  | ErrorMsg;

export type TransportEvent =
  /** The socket opened with `zakadi.v1`; `ms` since connect(). */
  | { k: "open"; region: string; ms: number }
  /** The first media message went out. */
  | { k: "first-media" }
  | { k: "server"; msg: SessionMsg }
  /** A rung switch reached the wire (6.2.7 step 2). */
  | { k: "rung"; from: number; to: number; reason: RungMsg["reason"] }
  | { k: "stats"; s: StatsMsg }
  /** The keyframe_request telemetry of 6.2.7: from the server's `keyframe` to the first IDR sent. */
  | { k: "keyframe_request"; ms_to_idr: number }
  /**
   * The session failed. Media has stopped; after network_floor the socket stays open
   * for `end` and the close, which still arrive.
   */
  | { k: "fatal"; code: ErrorCode }
  /** The socket closed after it had opened. */
  | { k: "closed"; code: number; reason: string };

export interface ConnectOptions {
  /** The WebSocket constructor: the platform's, or a fake. */
  WebSocket: new (url: string, protocols: string[]) => Socket;
  /** The candidates in rankIngest() order. */
  ranked: IngestCandidate[];
  /** Sent first; its token is blanked and dropped right after (6.9). */
  hello: HelloMsg;
  cameraMeta: CameraMetaMsg;
  /** The 16 raw bytes of the token's `jti` claim, for the chain (6.2.6). */
  jti: Uint8Array;
  media: Media;
  /** device_quirks `max_rung`: the best rung this device may use; default 0. */
  maxRung?: number;
  emit: (e: TransportEvent) => void;
}

export interface Transport {
  /** Sends `audio_state` or `ui_event` at once; `bye` after the final `attest`, stopping media. */
  send(msg: AudioStateMsg | UiEventMsg | ByeMsg): void;
  /** Stops media and timers and closes the socket without `bye`. */
  close(): void;
}

const FORWARD = /^(ready|probe_result|ui|say|action|tile|feedback|end|error)$/;

/**
 * Runs one `zakadi.v1` session from the socket to its close (spec/06-web-sdk.md 6.2.6,
 * 6.2.7, 6.2.10; spec/05-sdk-contract.md 5.6; spec/01-protocol.md 1.1 to 1.5).
 */
export function connect(o: ConnectOptions): Transport {
  const { WebSocket: WS, ranked, cameraMeta, jti, media, emit } = o;
  const best = o.maxRung ?? 0;
  let hello: HelloMsg | null = o.hello;
  const mr = hello.caps.profile === "mediarecorder";
  const now = () => performance.now();
  const t0 = now();

  let ws: Socket | undefined;
  let dials = 0;
  let opened = false; // the socket opened: never a second one (1.9)
  let over = false; // failed or closed: nothing more is sent
  let ready: ReadyMsg | undefined;
  let loop: Loop | undefined;
  let chain: Chain | undefined;
  let desc: MediaConfig | undefined;
  let streaming = false;
  let stopped = false; // media.stop() called
  let byeing = false; // bye queued behind the final attest
  let ended = false; // `end` received
  let sent = 0; // the rung of the media on the wire
  let ar = 0; // the rung and decimation applied to media
  let ad: Decimation = 0;
  let why: RungMsg["reason"] = "backpressure";
  let vseq = 0;
  let aseq = 0;
  let vrc = false; // rung_changed pending, per track (G1)
  let arc = false;
  let nextAttest = Infinity;
  let limit = Infinity;
  let held: Chunk[] | null = []; // audio before the first video chunk; null once it went out
  let batch: Chunk[] = [];
  let rtt: number | null = null; // the latest RTT estimate
  let rttAt = -Infinity; // when a server rtt_ms last arrived
  let pid = ""; // the pending own ping
  let pat = 0;
  let pn = 0;
  let kfAt = -1; // the pending server keyframe request
  let intervals: ReturnType<typeof setInterval>[] = [];
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const openTimer = setTimeout(() => fail("network_unavailable"), 8000);

  const drop = () => {
    if (hello) hello.token = "";
    hello = null;
  };

  const stopMedia = () => {
    if (streaming && !stopped) {
      stopped = true;
      media.stop();
    }
  };

  const halt = () => {
    stopMedia();
    intervals.forEach(clearInterval);
    intervals = [];
    [openTimer, readyTimer, probeTimer].forEach(clearTimeout);
  };

  const fail = (code: ErrorCode) => {
    if (over) return;
    over = true;
    halt();
    drop();
    ws?.close();
    emit({ k: "fatal", code });
  };

  const text = (m: ClientMsg) => {
    if (ws?.readyState !== 1) return;
    const s = JSON.stringify(m);
    ws.send(s);
    loop?.count(s.length, false);
  };

  const bin = (b: ArrayBuffer, isMedia: boolean) => {
    if (ws?.readyState !== 1) return;
    ws.send(b);
    loop?.count(b.byteLength, isMedia);
    if (isMedia) chain!.feed(b);
  };

  // at_ms on the media clock, 0 before its first frame (1.3.3, 6.2.5).
  const at = () => {
    const t = media.origin();
    return t === null ? 0 : Math.max(0, Math.floor(now() - t));
  };

  const attest = () => chain!.attest().then(text);

  // The `config` of the rung on the wire, or of a keyframe boost (6.2.7, G2).
  const config = (kbps?: number) => {
    const { video, audio, ...rest } = (desc = media.describe());
    const r = ready!.ladder[sent]!;
    text({
      t: "config",
      video: {
        ...video,
        w: r.w,
        h: r.h,
        fps: r.fps,
        bitrate_kbps: kbps ?? r.video_kbps,
        mirrored: false,
        rotation: 0,
      },
      audio: { ...audio, bitrate_kbps: r.audio_kbps },
      rung: sent,
      ...rest,
    });
  };

  const rungMsg = (reason: RungMsg["reason"]) =>
    text({
      t: "rung",
      rung: sent,
      reason,
      from_video_seq: vseq,
      from_audio_seq: aseq,
    });

  const flush = () => {
    if (!batch.length) return;
    bin(
      packBatch({ rc: arc, rung: sent, seq: aseq, pts: batch[0]!.ts }, batch),
      true,
    );
    aseq = (aseq + 1) & 0xffff;
    arc = false;
    batch = [];
  };

  const audio = (c: Chunk) => {
    // audio_batch at rungs 3 and 4, WebCodecs Opus only, three packets a message.
    if (
      !mr &&
      sent > 2 &&
      desc!.audio.codec === "opus" &&
      !desc!.audio.container
    ) {
      batch.push(c);
      if (batch.length > 2) flush();
      return;
    }
    bin(
      pack(AUDIO, { rc: arc, rung: sent, seq: aseq, pts: c.ts }, c.data),
      true,
    );
    aseq = (aseq + 1) & 0xffff;
    arc = false;
  };

  const chunk = (c: Chunk) => {
    if (over || byeing || ended) return;
    if (c.audio) {
      if (held) held.push(c);
      else audio(c);
      return;
    }
    if (held) {
      // `config` goes before the first media message (1.4).
      sent = c.rung;
      config();
      emit({ k: "first-media" });
    } else if (c.rung !== sent) {
      // The barrier: rung, config, then this chunk flagged (6.2.7 step 2).
      flush();
      const from = sent;
      sent = c.rung;
      rungMsg(why);
      config();
      vrc = arc = true;
      emit({ k: "rung", from, to: sent, reason: why });
    }
    const h = {
      key: c.key,
      ps: c.ps,
      rc: vrc,
      rung: sent,
      seq: vseq,
      pts: c.ts,
    };
    bin(
      c.prefix ? pack(VIDEO, h, c.prefix, c.data) : pack(VIDEO, h, c.data),
      true,
    );
    vseq = (vseq + 1) & 0xffff;
    vrc = false;
    if (c.key) {
      loop!.idr(now());
      if (kfAt >= 0) emit({ k: "keyframe_request", ms_to_idr: now() - kfAt });
      kfAt = -1;
    }
    if (held) {
      const a = held;
      held = null;
      a.forEach(audio);
    }
    if (c.ts >= nextAttest) {
      // Each time the video pts crosses a multiple of attest_interval_ms.
      const i = ready!.attest_interval_ms;
      nextAttest = (Math.floor(c.ts / i) + 1) * i;
      void attest();
    }
    if (c.ts >= limit) stopMedia(); // max_media_ms - 500 (6.2.10)
  };

  // Media and timers stop; the final attest, then bye, while the socket is open.
  const bye = (m: ByeMsg) => {
    if (over || byeing || ended || ws?.readyState !== 1) return;
    flush();
    byeing = true;
    halt();
    if (chain)
      void chain.attest().then((a) => {
        text(a);
        text(m);
      });
    else text(m);
  };

  // The rung and decimation the loop or set_rung chose, applied to media (6.2.7 step 1);
  // a recorder can do neither.
  const apply = () => {
    const { rung, decimation } = loop!.s;
    if (mr || (rung === ar && decimation === ad)) return;
    ar = rung;
    ad = decimation;
    media.apply(ready!.ladder[rung]!, decimation);
  };

  const tick = () => {
    const out = loop!.run(now(), ws!.bufferedAmount);
    if (out.kind === "floor_breached") {
      bye({ t: "bye", reason: "floor_breached" });
      emit({ k: "fatal", code: "network_floor" });
      return;
    }
    if (out.kind === "rung") why = out.reason;
    apply();
  };

  const stats = () => {
    const s: StatsMsg = {
      t: "stats",
      queued_bytes: ws!.bufferedAmount,
      queue_ms: Math.round(loop!.q),
      encoded_kbps: Math.round(loop!.kbps),
      rtt_ms: rtt === null ? null : Math.round(rtt),
      ...media.counters(),
    };
    text(s);
    emit({ k: "stats", s });
  };

  // Own ping once a second while no server rtt_ms arrived in the last 2 s (1.1).
  const ping = () => {
    if (now() - rttAt < 2000) return;
    pid = "c" + ++pn;
    pat = now();
    text({ t: "ping", id: pid, at_ms: at() });
  };

  const begin = (rung: number) => {
    if (streaming || over || byeing || ended) return;
    streaming = true;
    clearTimeout(probeTimer);
    sent = ar = rung;
    loop!.begin(rung, now(), !mr);
    media.start(ready!.ladder[rung]!, chunk);
    intervals = [
      setInterval(tick, 200),
      setInterval(stats, ready!.stats_interval_ms),
      setInterval(ping, 1000),
    ];
  };

  const recv = (data: string) => {
    let m: ServerMsg;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (over || !m?.t) return;
    const n = now();
    if (FORWARD.test(m.t)) emit({ k: "server", msg: m as SessionMsg });
    switch (m.t) {
      case "ready": {
        if (ready) break;
        clearTimeout(readyTimer);
        ready = m;
        loop = new Loop(m.ladder, best);
        chain = new Chain(m.session_id, jti);
        limit = m.max_media_ms - 500;
        nextAttest = m.attest_interval_ms;
        // The probe: count messages back to back, then probe_done (5.6).
        const { count, bytes } = m.probe;
        let first = 0;
        let last = 0;
        for (let i = 0; i < count; i++) {
          last = Math.round(now() * 1000);
          if (!i) first = last;
          bin(packProbe(bytes, i, last), false);
        }
        text({
          t: "probe_done",
          sent: count,
          bytes: count * bytes,
          first_send_us: first,
          last_send_us: last,
        });
        probeTimer = setTimeout(
          () => begin(Math.max(3, m.start_rung, best)),
          3000,
        );
        break;
      }
      case "probe_result":
        rtt = m.rtt_ms;
        if (ready)
          begin(startRung(ready.ladder, m.goodput_kbps, m.start_rung, best));
        break;
      case "ping":
        text({ t: "pong", re: m.id, at_ms: at() });
        if (m.rtt_ms != null) {
          loop?.rtt(m.rtt_ms, n);
          rtt = m.rtt_ms;
          rttAt = n;
        }
        if (m.rx_kbps != null) loop?.rx(m.rx_kbps, n);
        break;
      case "pong":
        if (pid && m.re === pid) {
          rtt = n - pat;
          loop?.rtt(rtt, n);
          pid = "";
        }
        break;
      case "keyframe":
        // Ignored on mediarecorder (1.5).
        if (mr || !streaming || byeing || ended) break;
        loop!.keyframe(n);
        kfAt = n;
        media.keyframe(m.boost_kbps, m.boost_ms);
        if (m.boost_kbps && m.boost_ms && !held) {
          config(m.boost_kbps);
          setTimeout(() => {
            if (!over && !byeing && !ended) config();
          }, m.boost_ms);
        }
        break;
      case "set_rung": {
        if (!streaming || byeing || ended) break;
        const to = Math.min(Math.max(m.rung, best), 4);
        // Answered at once when the rung on the wire stays; mediarecorder cannot change (G8).
        if (mr || to === sent) rungMsg("server");
        if (mr) break;
        loop!.set(to, n);
        why = "server";
        apply();
        break;
      }
      case "end":
        ended = true;
        halt();
        if (!byeing) void attest();
        break;
    }
  };

  const dial = (): void => {
    const c = ranked[dials++];
    if (!c) return fail("network_unavailable");
    let s: Socket;
    try {
      s = ws = new WS(c.url, [ZAKADI_SUBPROTOCOL]);
    } catch {
      return dial();
    }
    s.binaryType = "arraybuffer";
    s.onopen = () => {
      if (over) return;
      opened = true;
      clearTimeout(openTimer);
      if (s.protocol !== ZAKADI_SUBPROTOCOL) return fail("protocol_error");
      emit({ k: "open", region: c.region, ms: now() - t0 });
      // The token is presented once, in the first message, then dropped (1.1, 6.9).
      text(hello!);
      drop();
      text(cameraMeta);
      readyTimer = setTimeout(() => fail("network_unavailable"), 10000);
    };
    s.onmessage = (e) => {
      if (typeof e.data === "string") recv(e.data);
    };
    s.onclose = (e) => {
      // Before open the token was never presented: the next candidate.
      if (!opened) return void (over || dial());
      over = true;
      halt();
      drop();
      emit({ k: "closed", code: e.code, reason: e.reason });
    };
  };
  dial();

  return {
    send(m) {
      if (m.t === "bye") bye(m);
      else if (!byeing) text(m);
    },
    close() {
      if (over) return;
      over = true;
      halt();
      drop();
      ws?.close(1000);
    },
  };
}
