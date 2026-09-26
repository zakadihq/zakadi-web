// Prompt playback (spec/06-web-sdk.md 6.2.9, spec/01-protocol.md 1.4 `audio_state`,
// 1.5 `say`): Web Audio on the main thread, one playback per `say`, bracketed by one
// `audio_state started` and one `ended` on the session media clock.
import { TERMINAL_STATES } from "@zakadi/protocol";
import type { AudioStateMsg, SayMsg, TerminalState } from "@zakadi/protocol";
import type { Fields, TelemetryName } from "../telemetry/index.js";
import {
  loadPack,
  type Clip,
  type LoadedPack,
  type Missing,
  type Pack,
  type PromptPackRef,
} from "./pack.js";

// The first clip starts 30 ms ahead; each next clip at the previous start plus its
// manifest duration plus 120 ms; a 10 ms poll finds the start.
const LEAD_S = 0.03;
const GAP_S = 0.12;
const POLL_MS = 10;
// 5.8: a local terminal cue only when no `say` arrived in the 3 s before.
const QUIET_MS = 3000;

/** What the session wires in. */
export interface AudioOptions {
  /** Sends an `audio_state` message on the socket. */
  send(msg: AudioStateMsg): void;
  /** Maps a `performance.now()` time to milliseconds on the session media clock. */
  mediaMs(perfMs: number): number;
  /** Records a telemetry event: `pack_fetch`, `cue_play` and `cue_missing` here. */
  emit(name: TelemetryName, fields?: Fields): void;
}

export interface Audio {
  /**
   * Loads a prompt pack, at `start()` and again for a language chosen on the consent
   * screen. Resolves when every file is settled or 5 s have passed; rejects with
   * PackUnavailableError without a manifest. A new load replaces the one before,
   * which stops early: only the newest result counts.
   */
  load(ref: PromptPackRef): Promise<LoadedPack>;
  /**
   * Creates or resumes the AudioContext and plays one silent sample; call it
   * synchronously in the click handler of a user gesture. Decoding follows.
   */
  unlock(): void;
  /** Plays a `say`: now when `interrupt` is set, else after what is queued. */
  say(msg: SayMsg): void;
  /** Plays `consent.recording_notice`, the consent screen's "Listen" (6.4.6). */
  notice(): void;
  /**
   * Plays the local cue of a terminal state unless a `say` arrived in the 3 s
   * before, when the server's closing cue stands (5.8); returns whether it plays.
   */
  terminal(state: TerminalState): boolean;
  /** The playback bus, for the listening ring; null before `unlock()`. */
  readonly analyser: AnalyserNode | null;
  /** Stops playback and closes the AudioContext; sends nothing. */
  dispose(): void;
}

interface Playback {
  /** The `say` id; local cues have none and send no `audio_state`. */
  re: string | undefined;
  cue: string;
  /** The cue, then its `digit.N` or `count.N` clips. */
  ids: string[];
  /** `performance.now()` when it was asked for. */
  at: number;
  sources: AudioBufferSourceNode[];
  /** Context times of the first clip's start and the last clip's end. */
  when: number;
  end: number;
  started: boolean;
  done: boolean;
  poll?: ReturnType<typeof setInterval>;
}

export function createAudio(options: AudioOptions): Audio {
  let ctx: AudioContext | null = null;
  let bus: AnalyserNode | null = null;
  let pack: Pack | null = null;
  let current: Playback | null = null;
  const queue: Playback[] = [];
  let lastSay = -Infinity;

  const decode = (clip: Clip): Promise<AudioBuffer | null> => {
    if (!clip.buf && ctx && clip.bytes) {
      clip.buf = ctx.decodeAudioData(clip.bytes.buffer).catch(() => null);
      clip.bytes = null;
    }
    return clip.buf ?? Promise.resolve(null);
  };

  const buffer = async (
    id: string,
  ): Promise<[AudioBuffer, number] | Missing> => {
    const clip = pack?.clips.get(id);
    if (!clip)
      return (
        pack?.failed.get(id) ??
        (pack?.manifest?.cues[id] ? "not_loaded" : "not_in_pack")
      );
    const buf = await decode(clip);
    return buf ? [buf, clip.dur] : "decode";
  };

  // The performance.now() time at which context time `t` is heard: `t` plus the
  // output latency, mapped through getOutputTimestamp(), or through currentTime
  // where the browser gives no timestamp.
  const heard = (c: AudioContext, t: number): number => {
    const stamp = c.getOutputTimestamp?.();
    const audible = t + (c.outputLatency || c.baseLatency || 0);
    return stamp?.performanceTime
      ? stamp.performanceTime + (audible - (stamp.contextTime ?? 0)) * 1000
      : performance.now() + (audible - c.currentTime) * 1000;
  };

  const report = (
    p: Playback,
    event: AudioStateMsg["event"],
    perfMs: number,
  ): void => {
    if (p.re !== undefined)
      options.send({
        t: "audio_state",
        re: p.re,
        event,
        at_ms: Math.max(0, Math.round(options.mediaMs(perfMs))),
      });
  };

  const silence = (p: Playback): void => {
    p.done = true;
    clearInterval(p.poll);
    for (const source of p.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
  };

  // Ends a playback: its sources stop and `ended` is sent at the end of its audio,
  // after `started` when no poll had seen the start yet.
  const finish = (p: Playback): void => {
    if (p.done) return;
    silence(p);
    const perfMs =
      ctx && p.sources.length
        ? heard(ctx, Math.min(ctx.currentTime, p.end))
        : performance.now();
    if (!p.started) report(p, "started", perfMs);
    report(p, "ended", perfMs);
    if (current === p) current = null;
  };

  const fail = (p: Playback): void => {
    p.done = true;
    report(p, "failed", performance.now());
    current = null;
    next();
  };

  const begin = (c: AudioContext, p: Playback): void => {
    if (p.done || c.currentTime < p.when) return;
    clearInterval(p.poll);
    p.started = true;
    const perfMs = heard(c, p.when);
    report(p, "started", perfMs);
    options.emit("cue_play", {
      cue: p.cue,
      ms_to_start: Math.round(perfMs - p.at),
    });
  };

  const prepare = async (p: Playback): Promise<void> => {
    const c = ctx;
    const got = c ? await Promise.all(p.ids.map(buffer)) : [];
    if (p.done) return;
    if (!c || c.state !== "running") return fail(p);
    let missing = false;
    got.forEach((g, i) => {
      if (typeof g === "string") {
        missing = true;
        options.emit("cue_missing", { cue: p.ids[i] ?? "", reason: g });
      }
    });
    if (missing) return fail(p);
    let when = (p.when = c.currentTime + LEAD_S);
    for (const [buf, dur] of got as [AudioBuffer, number][]) {
      const source = c.createBufferSource();
      source.buffer = buf;
      source.connect(bus as AnalyserNode);
      source.start(when);
      p.sources.push(source);
      p.end = when + buf.duration;
      when += dur / 1000 + GAP_S;
    }
    (p.sources[p.sources.length - 1] as AudioBufferSourceNode).onended = () => {
      finish(p);
      next();
    };
    p.poll = setInterval(() => begin(c, p), POLL_MS);
  };

  const next = (): void => {
    const p = current ? undefined : queue.shift();
    if (p) {
      current = p;
      void prepare(p);
    }
  };

  const enqueue = (
    ids: string[],
    re: string | undefined,
    interrupt: boolean,
  ): void => {
    const p: Playback = {
      re,
      cue: ids[0] ?? "",
      ids,
      at: performance.now(),
      sources: [],
      when: 0,
      end: 0,
      started: false,
      done: false,
    };
    if (interrupt) {
      queue.unshift(p);
      if (current) finish(current);
    } else queue.push(p);
    next();
  };

  return {
    load(ref) {
      pack?.ctrl.abort();
      const loading: Pack = {
        ref,
        ctrl: new AbortController(),
        clips: new Map(),
        failed: new Map(),
      };
      pack = loading;
      // A replaced load stops early and reports nothing more.
      return loadPack(
        loading,
        (name, fields) => {
          if (pack === loading) options.emit(name, fields);
        },
        (clip) => {
          if (pack === loading) void decode(clip);
        },
      );
    },
    unlock() {
      try {
        if (!ctx) {
          ctx = new AudioContext({ latencyHint: "interactive" });
          bus = ctx.createAnalyser();
          bus.connect(ctx.destination);
        }
        ctx.resume().catch(() => undefined);
        const source = ctx.createBufferSource();
        source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        source.connect(ctx.destination);
        source.start();
      } catch {
        // No Web Audio: every say fails and the call runs on captions.
      }
      pack?.clips.forEach((clip) => void decode(clip));
    },
    say(msg) {
      lastSay = performance.now();
      const ids = [
        msg.cue,
        ...(msg.params?.digits ?? []).map((d) => "digit." + d),
      ];
      if (msg.params?.count) ids.push("count." + msg.params.count);
      enqueue(ids, msg.id, msg.interrupt === true);
    },
    notice() {
      enqueue(["consent.recording_notice"], undefined, true);
    },
    terminal(state) {
      if (performance.now() - lastSay < QUIET_MS) return false;
      enqueue([TERMINAL_STATES[state].cue], undefined, true);
      return true;
    },
    get analyser() {
      return bus;
    },
    dispose() {
      pack?.ctrl.abort();
      pack = null;
      queue.length = 0;
      if (current) silence(current);
      current = null;
      ctx?.close().catch(() => undefined);
      ctx = bus = null;
    },
  };
}
