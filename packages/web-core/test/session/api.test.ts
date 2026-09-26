import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "../../src/index";
import {
  createZakadiSession,
  LIVENESS_EVENT_TYPES,
  ZakadiError,
  type ZakadiConfig,
  type ZakadiEventMap,
} from "../../src/index";
import { makePack } from "../audio/fakes";
import {
  begin,
  FakeRenderer,
  setup,
  teardown,
  toActive,
  token,
  until,
} from "./harness";

// The public API of spec/06-web-sdk.md 6.2.2 over spec/05-sdk-contract.md 5.2 and 5.11.
afterEach(teardown);

async function config(o: Partial<ZakadiConfig> = {}): Promise<ZakadiConfig> {
  const pack = await makePack({ cues: { "greet.short": 800 } });
  return {
    clientToken: token(),
    ingest: [{ region: "eu-west-2", url: "wss://ingest.zakadi.test/s" }],
    promptPack: pack.ref,
    sessionUi: { consent_copy: {} },
    locale: "en-NG",
    ...o,
  };
}

describe("the exports", () => {
  it("are createZakadiSession, ZakadiError and LIVENESS_EVENT_TYPES", () => {
    expect(Object.keys(core).sort()).toEqual([
      "LIVENESS_EVENT_TYPES",
      "ZakadiError",
      "createZakadiSession",
    ]);
  });

  it("list every event of ZakadiEventMap (5.11)", () => {
    const all: Record<keyof ZakadiEventMap, true> = {
      state_changed: true,
      consent_given: true,
      permission: true,
      connected: true,
      active: true,
      phase: true,
      ended: true,
      error: true,
      disconnected: true,
      redial_requested: true,
      closed: true,
    };
    expect([...LIVENESS_EVENT_TYPES].sort()).toEqual(Object.keys(all).sort());
  });

  it("ZakadiError carries code, recoverable and retryAfterS", () => {
    const e = new ZakadiError("admission_rejected", "close 4008", true, 5);
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({
      name: "ZakadiError",
      code: "admission_rejected",
      message: "close 4008",
      recoverable: true,
      retryAfterS: 5,
    });
  });
});

describe("createZakadiSession()", () => {
  it("has no side effect: no request, timer, listener, camera, worker or element", async () => {
    const c = await config({ ui: { mode: "default" } });
    const spies = {
      fetch: vi.fn(),
      getUserMedia: vi.fn(),
      setTimeout: vi.spyOn(globalThis, "setTimeout"),
      setInterval: vi.spyOn(globalThis, "setInterval"),
      Worker: vi.fn(),
      WebSocket: vi.fn(),
      AudioContext: vi.fn(),
      addEventListener: vi.fn(),
      createElement: vi.fn(),
      define: vi.fn(),
      get: vi.fn(),
    };
    vi.stubGlobal("fetch", spies.fetch);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: spies.getUserMedia },
    });
    vi.stubGlobal("Worker", spies.Worker);
    vi.stubGlobal("WebSocket", spies.WebSocket);
    vi.stubGlobal("AudioContext", spies.AudioContext);
    vi.stubGlobal("addEventListener", spies.addEventListener);
    vi.stubGlobal("document", {
      createElement: spies.createElement,
      addEventListener: spies.addEventListener,
    });
    vi.stubGlobal("customElements", { define: spies.define, get: spies.get });
    const s = createZakadiSession(c);
    expect(s.state).toBe("idle");
    expect(s.profile).toBeNull();
    expect(s.consentRecord).toBeNull();
    for (const [name, spy] of Object.entries(spies))
      expect(spy, name).not.toHaveBeenCalled();
  });

  it("throws TypeError for a missing or malformed token, ingest, pack or sessionUi (5.11)", async () => {
    const c = await config();
    const bad: Partial<Record<keyof ZakadiConfig, unknown>>[] = [
      { clientToken: "" },
      { clientToken: undefined },
      { clientToken: "not.a-token" },
      { ingest: [] },
      { promptPack: undefined },
      { sessionUi: undefined },
      { locale: undefined },
    ];
    for (const o of bad)
      expect(
        () => createZakadiSession({ ...c, ...o } as ZakadiConfig),
        JSON.stringify(o),
      ).toThrow(TypeError);
    expect(() =>
      createZakadiSession(undefined as unknown as ZakadiConfig),
    ).toThrow(TypeError);
  });
});

describe("misuse throws TypeError, never an SDK error code (5.11, D53)", () => {
  it("start() twice, start() or attach() after dispose()", async () => {
    const h = await setup();
    const first = begin(h, false);
    await expect(h.session.start()).rejects.toThrow(TypeError);
    h.session.dispose();
    await until(() => first.result.ok === false);
    expect(first.result.error).toMatchObject({ code: "cancelled" });
    await expect(h.session.start()).rejects.toThrow(TypeError);
    expect(() => h.session.attach({} as HTMLElement)).toThrow(TypeError);
  });

  it("an unknown event, a handler that is not a function, a bad consent or control", async () => {
    const h = await setup();
    expect(() =>
      h.session.on("nope" as keyof ZakadiEventMap, () => {}),
    ).toThrow(TypeError);
    expect(() => h.session.on("active", 3 as never)).toThrow(TypeError);
    const bridge = h.session.headless!;
    expect(() =>
      bridge.submitConsent("yes" as unknown as boolean, "en-NG", false),
    ).toThrow(TypeError);
    expect(() => bridge.press("nope" as "repeat")).toThrow(TypeError);
  });

  it("start() in the default UI mode without a defined <zakadi-call> names @zakadi/ui", async () => {
    const h = await setup({ config: { ui: { mode: "default" } } });
    vi.stubGlobal("customElements", { get: () => undefined });
    await expect(h.session.start()).rejects.toThrow(/@zakadi\/ui/);
    expect(h.session.state).toBe("idle");
  });

  it("attach() of an element that is not a renderer, when binding", async () => {
    const h = await setup({ config: { ui: { mode: "default" } } });
    h.session.attach({} as HTMLElement);
    await expect(h.session.start()).rejects.toThrow(TypeError);
  });
});

describe("the default UI mode", () => {
  it("start() mounts a defined <zakadi-call> into ui.container and binds it", async () => {
    const container = { append: vi.fn() };
    const h = await setup({
      config: {
        ui: { mode: "default", container: container as unknown as HTMLElement },
      },
    });
    vi.stubGlobal("customElements", { get: () => class {} });
    const b = begin(h, false);
    await until(() => h.session.state === "consent");
    const el = container.append.mock.calls[0]![0] as FakeRenderer;
    expect(h.doc.createElement).toHaveBeenCalledWith("zakadi-call");
    expect(el.bridge!.view().screen).toBe("consent");
    expect(h.session.headless).toBeNull();
    // A dismissal releases everything and removes the mounted element (5.11).
    el.bridge!.close();
    await until(() => b.result.ok === false);
    expect(el.removed).toBe(true);
    expect(el.bridge).toBeNull();
  });

  it("start() binds an attached element and mounts none", async () => {
    const h = await setup({ headless: false });
    begin(h, false);
    await until(() => h.session.state === "consent");
    expect(h.renderer!.bridge).not.toBeNull();
    expect(h.appended).toEqual([]);
  });
});

describe("the permission event (5.11, D52)", () => {
  it("is booleans: camera and microphone granted", async () => {
    const h = await setup();
    await toActive(h);
    expect(h.events).toContainEqual({
      type: "permission",
      camera: true,
      microphone: true,
    });
  });

  it("is booleans: both false on NotAllowedError, with permission_denied", async () => {
    const h = await setup({
      gumError: new DOMException("denied", "NotAllowedError"),
    });
    const b = begin(h);
    await until(() => b.result.ok === false);
    expect(h.events).toContainEqual({
      type: "permission",
      camera: false,
      microphone: false,
    });
    expect(b.result.error).toMatchObject({
      code: "permission_denied",
      recoverable: true,
    });
  });
});

describe("ui overrides on sessionUi, field by field (5.2, D40)", () => {
  it("replace the consent copy, the brand and the packs; the theme passes through", async () => {
    const h = await setup({
      headless: false,
      french: true,
      config: {
        ui: {
          mode: "default",
          consentCopy: {
            "en-NG": { title: "Verify it is you", body: "Two prompts." },
          },
          brand: { logo_url: "https://rp.example/logo.svg" },
          theme: { colorPrimary: "#123456", radius: "12px" },
          lottieRenderer: "canvas",
        },
      },
    });
    begin(h, false);
    await until(() => h.session.state === "consent");
    const v = h.renderer!.bridge!.view();
    expect(v.consentCopy).toEqual({
      title: "Verify it is you",
      body: "Two prompts.",
      recording_notice: "Two still frames are kept for 7 days.",
    });
    expect(v.brand).toEqual({
      primary: "#0A5",
      logo_url: "https://rp.example/logo.svg",
    });
    expect(v.theme).toEqual({ colorPrimary: "#123456", radius: "12px" });
    expect(v.languages).toEqual(["en-NG", "fr-CI"]);
    expect(v.lottieRenderer).toBe("canvas");
    expect(v.strings.consent.start).toBe("Start");
  });

  it("ui.alternatePacks replaces sessionUi.packs in the switcher", async () => {
    const other = await makePack({ cues: { "greet.short": 1 }, lang: "ha-NG" });
    const h = await setup({
      headless: false,
      french: true,
      config: { ui: { mode: "default", alternatePacks: [other.ref] } },
    });
    begin(h, false);
    await until(() => h.session.state === "consent");
    expect(h.renderer!.bridge!.view().languages).toEqual(["en-NG", "ha-NG"]);
  });
});
