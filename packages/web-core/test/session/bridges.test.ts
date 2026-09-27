import type { AudioStateMsg } from "@zakadi/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PALETTE } from "../audio/fakes";
import {
  begin,
  serve,
  setup,
  teardown,
  toActive,
  until,
  type Harness,
} from "./harness";

// The server's messages on the main thread (spec/01-protocol.md 1.2, spec/06-web-sdk.md
// 6.4.5, spec/05-sdk-contract.md 5.8): validated there, then handed in arrival order to
// the headless bridge or the renderer's; the terminal cue plays only after 3 s without
// a `say`.
afterEach(teardown);

// Valid and invalid messages, interleaved; unknown types are ignored (1.2).
const MESSAGES = [
  { t: "ui", state: { phase: "framing", caption: { text: "Hi." } } },
  { t: "tile", symbol: 9, min_ms: 400 }, // symbol out of range: dropped
  { t: "say", id: "s1", cue: "greet.short", caption: "Hi." },
  { t: "weather", sunny: true }, // unknown: ignored
  { t: "feedback", code: "too_dark", severity: "hint" },
  { t: "ui" }, // no state: dropped
  { t: "tile", symbol: 5, min_ms: 400 },
  { t: "say", cue: "ack.nice" }, // no id: dropped
  {
    t: "action",
    id: "a1",
    kind: "blink",
    params: { count: 1, window_ms: 3000 },
    deadline_ms: 7000,
  },
  { t: "ui", state: { phase: "action", unknown_field: 1 } }, // extra field: kept
];
const ORDER = [
  "ui framing",
  "say s1",
  "feedback too_dark",
  `tile 5 ${PALETTE[5]!.join(",")}`,
  "ui action",
];

async function played(h: Harness) {
  for (const m of MESSAGES) serve(h, m);
  await vi.advanceTimersByTimeAsync(10);
}

describe("the headless bridge (6.4.5)", () => {
  it("gets the valid messages in arrival order, tiles with their palette colour", async () => {
    const h = await setup();
    const got: string[] = [];
    const b = h.session.headless!;
    b.onUi((s) => got.push("ui " + s.phase));
    b.onTile((m, hsl) => got.push(`tile ${m.symbol} ${hsl.join(",")}`));
    b.onSay((m) => got.push("say " + m.id));
    const off = b.onFeedback((m) => got.push("feedback " + m.code));
    await toActive(h);
    expect(b.previewStream()).not.toBeNull();
    await played(h);
    expect(got).toEqual(ORDER);
    // phase follows the valid `ui` messages only.
    expect(h.events.filter((e) => e.type === "phase")).toEqual([
      { type: "phase", phase: "framing" },
      { type: "phase", phase: "action" },
    ]);
    off();
    serve(h, { t: "feedback", code: "blurry", severity: "hint" });
    expect(got).toHaveLength(ORDER.length);
  });

  it("still plays each say and brackets it with audio_state on the media clock", async () => {
    const h = await setup();
    await toActive(h);
    serve(h, { t: "say", id: "s1", cue: "greet.short", caption: "Hi." });
    await vi.advanceTimersByTimeAsync(2000);
    const states = h
      .sock()
      .texts()
      .filter((m): m is AudioStateMsg => m.t === "audio_state");
    expect(states.map((m) => `${m.re} ${m.event}`)).toEqual([
      "s1 started",
      "s1 ended",
    ]);
    expect(states[0]!.at_ms).toBeGreaterThan(0);
    expect(states[1]!.at_ms).toBeGreaterThan(states[0]!.at_ms);
  });

  it("palette() is empty before the manifest loads and its tile_palette from the first onUi call on (6.2.2, 6.4.3)", async () => {
    const h = await setup();
    const b = h.session.headless!;
    const at: [string, unknown][] = [["idle", b.palette()]];
    h.session.on("state_changed", (e) => at.push([e.to, b.palette()]));
    const onUi: unknown[] = [];
    b.onUi(() => onUi.push(b.palette()));
    await toActive(h);
    serve(h, { t: "ui", state: { phase: "framing" } });
    serve(h, { t: "ui", state: { phase: "action" } });
    await vi.advanceTimersByTimeAsync(10);
    // The manifest is applied once the pack has loaded, during connecting.
    expect(at).toEqual([
      ["idle", []],
      ["consent", []],
      ["permission", []],
      ["connecting", []],
      ["active", PALETTE],
    ]);
    expect(onUi).toEqual([PALETTE, PALETTE]);
    expect(b.palette()).toEqual(h.pack.manifest.tile_palette);
  });

  it("palette() stays empty when no manifest loads", async () => {
    const h = await setup({ noPack: true });
    const b = h.session.headless!;
    const at: unknown[] = [b.palette()];
    h.session.on("state_changed", () => at.push(b.palette()));
    begin(h);
    await until(() => h.session.state === "error");
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "error", code: "pack_unavailable" }),
    );
    expect(at).toEqual([[], [], [], [], []]);
  });

  it("palette() is a copy: changing what it returned leaves later onTile colours unchanged (5.8)", async () => {
    const h = await setup();
    const b = h.session.headless!;
    const got: string[] = [];
    b.onTile((m, hsl) => got.push(`tile ${m.symbol} ${hsl.join(",")}`));
    await toActive(h);
    const p = b.palette() as [number, number, number][];
    p[5]![0] = 0; // an entry changed in place
    p[3] = [0, 0, 0]; // an entry replaced
    p.length = 1; // entries removed
    serve(h, { t: "tile", symbol: 5, min_ms: 400 });
    serve(h, { t: "tile", symbol: 3, min_ms: 400 });
    await vi.advanceTimersByTimeAsync(10);
    expect(got).toEqual([
      `tile 5 ${PALETTE[5]!.join(",")}`,
      `tile 3 ${PALETTE[3]!.join(",")}`,
    ]);
    expect(b.palette()).toEqual(PALETTE);
  });

  it("press(): repeat and more_time as ui_event; cancel adds bye user_cancel (6.4.2)", async () => {
    const h = await setup();
    await toActive(h);
    const b = h.session.headless!;
    b.press("repeat");
    b.press("more_time");
    b.press("cancel");
    await vi.advanceTimersByTimeAsync(10);
    const t = h
      .sock()
      .texts()
      .filter((m) => m.t === "ui_event" || m.t === "bye");
    expect(t.map((m) => ("event" in m ? m.event : m.t))).toEqual([
      "repeat_requested",
      "more_time_requested",
      "cancel_pressed",
      "bye",
    ]);
    expect(t.at(-1)).toEqual({ t: "bye", reason: "user_cancel" });
  });
});

describe("the renderer bridge", () => {
  it("gets the same messages in the same order", async () => {
    const h = await setup({ headless: false });
    await toActive(h);
    await played(h);
    expect(h.renderer!.got).toEqual(ORDER);
    const v = h.renderer!.bridge!.view();
    expect(v.screen).toBe("call");
    expect(v.previewHidden).toBe(false);
    expect(v.strings.badge).toBe("Automated check, no one is watching live");
  });

  it("hides the preview while the camera probe runs (6.4.6)", async () => {
    const h = await setup({ headless: false });
    await toActive(h);
    const views = h.renderer!.views;
    const connecting = views.filter((v) => v.screen === "connecting");
    expect(connecting[0]!.previewHidden).toBe(true);
    expect(connecting.at(-1)!.previewHidden).toBe(false);
  });

  it("brings the manifest's tile_palette with a view change (6.2.9, 6.4.3)", async () => {
    const h = await setup({ headless: false });
    await toActive(h);
    const views = h.renderer!.views;
    const at = views.findIndex((v) => !!v.palette?.length);
    // Empty in every view before the manifest, then its palette, before the call.
    expect(at).toBeGreaterThan(0);
    for (const v of views.slice(0, at)) expect(v.palette).toEqual([]);
    expect(views[at]!.screen).toBe("connecting");
    expect(views[at]!.palette).toEqual(h.pack.manifest.tile_palette);
    expect(views.findIndex((v) => v.screen === "call")).toBeGreaterThan(at);
    expect(h.renderer!.bridge!.view().palette).toEqual(PALETTE);
    expect(h.renderer!.bridge!.palette()).toEqual(PALETTE);
  });
});

describe("terminal cues (5.8, D39)", () => {
  const cues = (h: Harness) =>
    h.telemetry.flatMap((e) => (e.name === "cue_play" ? [e.fields.cue] : []));

  it("the local cue plays when no say arrived in the 3 s before the terminal state", async () => {
    const h = await setup();
    await toActive(h);
    await vi.advanceTimersByTimeAsync(3100);
    serve(h, { t: "end", outcome: "completed", reason: "ok", retry: false });
    await vi.advanceTimersByTimeAsync(200);
    expect(cues(h)).toEqual(["done.thanks"]);
  });

  it("the server's closing cue stands when a say arrived within 3 s", async () => {
    const h = await setup();
    await toActive(h);
    serve(h, { t: "say", id: "s9", cue: "greet.short" });
    await vi.advanceTimersByTimeAsync(1000);
    serve(h, { t: "end", outcome: "completed", reason: "ok", retry: false });
    await vi.advanceTimersByTimeAsync(3000);
    expect(cues(h)).toEqual(["greet.short"]);
  });

  it("messages after the terminal state reach no bridge", async () => {
    const h = await setup();
    const got: string[] = [];
    h.session.headless!.onUi((s) => got.push(s.phase));
    await toActive(h);
    serve(h, { t: "end", outcome: "completed", reason: "ok", retry: false });
    serve(h, { t: "ui", state: { phase: "done" } });
    await vi.advanceTimersByTimeAsync(10);
    expect(got).toEqual([]);
  });
});
