import { validateClientMsg } from "@zakadi/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZakadiError } from "../../src/session/errors";
import { FakeSocket } from "../transport/fakes";
import { FakeVideo } from "../capture/fakes";
import {
  begin,
  EventAudioContext,
  PROBE_RESULT,
  READY,
  serve,
  setup,
  teardown,
  toActive,
  toSocket,
  until,
} from "./harness";

// start() (spec/06-web-sdk.md 6.2.10, spec/05-sdk-contract.md 5.2): the SDK config,
// detection, consent, permission, the camera probe and region ranking in parallel, the
// pack, the socket with hello and camera_meta, ready, the network probe, probe_result
// and the first media message, when start() resolves.
afterEach(teardown);

describe("start()", () => {
  it("runs the 6.2.10 sequence and resolves at the first media message", async () => {
    const h = await setup();
    const log: string[] = [];
    h.fetch.mockImplementationOnce(async (input) => {
      log.push("sdk config");
      return Response.json({ min_version: "0.0.0", kill_switch: false });
      void input;
    });
    const gum = h.media.getUserMedia;
    const b = begin(h);
    // The pack fetch starts at start(), beside the SDK config (6.2.9).
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toContain(h.pack.ref.url);
    await b.consented;
    log.push("consent");
    await until(() => gum.mock.calls.length > 0);
    log.push("getUserMedia");
    await until(() => FakeSocket.all.length > 0);
    log.push("socket");
    expect(h.session.state).toBe("connecting");
    // The camera probe and the ranking ran before the socket.
    expect(h.video.applied.length).toBeGreaterThan(1);
    expect(h.calls.some((u) => u.endsWith("/v1/probe"))).toBe(true);
    expect(h.calls).toContain(h.pack.ref.url);
    h.sock().open();
    expect(
      h
        .sock()
        .texts()
        .map((m) => m.t),
    ).toEqual(["hello", "camera_meta"]);
    // The 13 steps of 1.4 within 3 s, the rest skipped.
    const probe = (h.sock().texts()[1] as { probe: { skipped?: boolean }[] })
      .probe;
    expect(probe).toHaveLength(13);
    expect(probe.at(-1)).toEqual({ request: { fps: 30 }, skipped: true });
    serve(h, READY);
    serve(h, PROBE_RESULT);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.result.ok).toBeUndefined();
    await until(() => b.result.ok === true);
    expect(h.session.state).toBe("active");
    expect(log).toEqual(["sdk config", "consent", "getUserMedia", "socket"]);
    expect(h.types(true)).toEqual([
      "state_changed",
      "consent_given",
      "state_changed",
      "permission",
      "state_changed",
      "connected",
      "state_changed",
      "active",
    ]);
    // Detection ran before consent: the candidates were checked at the rung 0 size.
    const checked = (
      globalThis.VideoEncoder as unknown as {
        isConfigSupported: { mock: { calls: [VideoEncoderConfig][] } };
      }
    ).isConfigSupported.mock.calls;
    expect(checked[0]![0]).toMatchObject({ width: 480, height: 640 });
    for (const m of h.sent())
      expect(validateClientMsg(m), JSON.stringify(m)).toBe(true);
  });

  it("goes idle, consent, permission, connecting, active", async () => {
    const h = await setup();
    await toActive(h);
    const states = h.events.flatMap((e) =>
      e.type === "state_changed" ? [`${e.from}>${e.to}`] : [],
    );
    expect(states).toEqual([
      "idle>consent",
      "consent>permission",
      "permission>connecting",
      "connecting>active",
    ]);
  });

  it("Safari 26: the worklet's blocks with clock pairs each second, and rVFC frames", async () => {
    const h = await setup();
    // No MSTP on the main thread: the worklet audio path and the rVFC video path (6.3).
    vi.stubGlobal("MediaStreamTrackProcessor", undefined);
    const node = () => ({
      connect: <T>(n: T) => n,
      disconnect: () => undefined,
    });
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        port = { name: "worklet port" };
        connect = <T>(n: T) => n;
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "GainNode",
      class {
        connect = <T>(n: T) => n;
      },
    );
    const addModule = vi.fn(async () => undefined);
    vi.stubGlobal(
      "AudioContext",
      class extends EventAudioContext {
        audioWorklet = { addModule };
        createMediaStreamSource = node;
      },
    );
    await toActive(h);
    expect(addModule).toHaveBeenCalledWith(
      expect.stringMatching(/\/capture\.worklet\.js$/),
    );
    const p = h.pipeline();
    expect(p.init.audio).toMatchObject({ kind: "pcm", sampleRate: 48000 });
    expect(p.init.video).toEqual({ kind: "frames" });
    const pairs = () => p.calls.filter((c) => c[0] === "clock").length;
    const before = pairs();
    await vi.advanceTimersByTimeAsync(2000);
    expect(pairs() - before).toBe(2);
    // The session's hidden video, appended after the probe's, pumps frames to the engine.
    const video = h.appended
      .filter((n) => n instanceof FakeVideo)
      .at(-1) as FakeVideo;
    video.present({ width: 480, height: 640 });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.calls).toContainEqual(["frame"]);
  });

  it("runs the mediarecorder profile inline, one recorder on the camera stream", async () => {
    const h = await setup();
    vi.stubGlobal("VideoEncoder", undefined);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        static isTypeSupported = (t: string) => t.startsWith("video/webm");
      },
    );
    await toActive(h);
    expect(h.hosts).toEqual(["mediarecorder"]);
    expect(h.session.profile).toBe("mediarecorder");
    expect(h.pipeline().init.recorder).toEqual({
      stream: expect.anything(),
      mime: "video/webm;codecs=vp8,opus",
    });
    expect(h.sock().texts()[0]).toMatchObject({
      caps: {
        profile: "mediarecorder",
        video: ["vp8"],
        audio: ["opus"],
        hw_encode: false,
        keyframe_on_demand: false,
        bitrate_reconfig: false,
      },
    });
  });

  it("assumes rung 3 when no probe_result arrives in 3 s, then resolves", async () => {
    const h = await setup();
    const b = await toSocket(h);
    h.sock().open();
    serve(h, READY);
    await vi.advanceTimersByTimeAsync(2900);
    expect(b.result.ok).toBeUndefined();
    await until(() => b.result.ok === true);
    expect(h.pipeline().calls).toContainEqual(["start", 3]);
  });

  it("sends hello with the SDK, caps, pack, a11y and consent, and camera_meta before media", async () => {
    const h = await setup();
    await toActive(h);
    const [hello, meta] = h.sock().texts();
    expect(hello).toMatchObject({
      t: "hello",
      v: 1,
      token: h.config.clientToken,
      sdk: { platform: "web", name: "@zakadi/web-core", version: "0.0.0" },
      caps: {
        profile: "webcodecs",
        video: ["avc1.42E01F", "vp8"],
        audio: ["opus"],
        hw_encode: true,
        keyframe_on_demand: true,
        bitrate_reconfig: true,
        max_resolution: { w: 720, h: 1280 },
        max_fps: 30,
        attestation: "none",
      },
      prompt_pack: { lang: "en-NG", version: "1.0.0" },
      a11y: { captions: true, extended_time: false },
      consent: { biometric: true, recording: true },
    });
    expect(meta!.t).toBe("camera_meta");
  });

  it("rejects with cancelled when cancel() comes before active", async () => {
    const h = await setup();
    const b = begin(h, false);
    await until(() => h.session.state === "consent");
    h.session.cancel("changed my mind");
    await vi.advanceTimersByTimeAsync(0);
    expect(b.result.ok).toBe(false);
    expect(b.result.error).toBeInstanceOf(ZakadiError);
    expect(b.result.error).toMatchObject({
      code: "cancelled",
      recoverable: true,
    });
    expect(h.session.state).toBe("error");
    expect(h.media.getUserMedia).not.toHaveBeenCalled();
  });

  it("cancel() with the socket open: attest and bye user_cancel, and start() rejects", async () => {
    const h = await setup();
    const b = await toSocket(h);
    h.sock().open();
    serve(h, READY);
    await vi.advanceTimersByTimeAsync(10);
    h.session.cancel();
    await vi.advanceTimersByTimeAsync(10);
    expect(b.result.error).toMatchObject({ code: "cancelled" });
    const t = h
      .sock()
      .texts()
      .map((m) => m.t);
    expect(t.slice(-2)).toEqual(["attest", "bye"]);
    expect(h.sock().texts().at(-1)).toEqual({
      t: "bye",
      reason: "user_cancel",
    });
    // A second cancel() changes nothing.
    h.session.cancel();
    expect(h.events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("fails pack_unavailable without a manifest in 5 s", async () => {
    const h = await setup({ noPack: true });
    const b = begin(h);
    await b.consented;
    await until(() => b.result.ok === false);
    expect(b.result.error).toMatchObject({ code: "pack_unavailable" });
    expect(FakeSocket.all).toHaveLength(0);
    expect(h.telemetry).toContainEqual(
      expect.objectContaining({
        name: "error",
        fields: { code: "pack_unavailable" },
      }),
    );
  });

  it("fails network_unavailable when no socket opens in 8 s", async () => {
    const h = await setup();
    const b = await toSocket(h);
    await vi.advanceTimersByTimeAsync(7990);
    expect(b.result.ok).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    expect(b.result.error).toMatchObject({ code: "network_unavailable" });
    expect(h.types()).toContain("error");
  });
});
