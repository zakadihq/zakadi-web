import type { HelloMsg } from "@zakadi/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../transport/fakes";
import { begin, setup, teardown, toActive, until } from "./harness";

// Consent (spec/05-sdk-contract.md 5.2, spec/06-web-sdk.md 6.2.9, 6.2.10): the record,
// its carry-over to a redial within 10 minutes in the same language, and the audio
// unlock inside the user's gesture.
afterEach(teardown);

const hello = () => FakeSocket.all[0]!.texts()[0] as HelloMsg;

describe("submitConsent()", () => {
  it("unlocks audio synchronously, inside the host's click handler (6.2.9)", async () => {
    const h = await setup();
    begin(h, false);
    await until(() => h.session.state === "consent");
    expect(h.ctx()).toBeUndefined();
    h.session.headless!.submitConsent(true, "en-NG", false);
    // Before any await: the context exists, was resumed, and played a silent sample;
    // decoding of the pack follows.
    const ctx = h.ctx()!;
    expect(ctx.options).toEqual({ latencyHint: "interactive" });
    expect(ctx.log.slice(0, 5)).toEqual([
      "new",
      "resume",
      "source",
      "buffer 1x1",
      "start",
    ]);
    expect(new Set(ctx.log.slice(5))).toEqual(new Set(["decode"]));
  });

  it("records the consent and exposes it for a redial", async () => {
    const h = await setup();
    vi.setSystemTime(new Date("2026-09-26T10:00:00Z"));
    await toActive(h);
    const record = {
      atMsWall: Date.parse("2026-09-26T10:00:00Z"),
      lang: "en-NG",
      extendedTime: false,
    };
    expect(h.session.consentRecord).toMatchObject({
      lang: "en-NG",
      extendedTime: false,
    });
    expect(h.session.consentRecord!.atMsWall).toBeGreaterThanOrEqual(
      record.atMsWall,
    );
    expect(h.events).toContainEqual({
      type: "consent_given",
      record: h.session.consentRecord,
    });
    expect(hello().consent.at_ms_wall).toBe(h.session.consentRecord!.atMsWall);
  });

  it("switches the pack to the language chosen and names it in hello", async () => {
    const h = await setup({ french: true });
    begin(h, false);
    await until(() => h.session.state === "consent");
    h.session.headless!.submitConsent(true, "fr", true);
    await until(() => FakeSocket.all.length > 0);
    FakeSocket.all[0]!.open();
    expect(h.calls).toContain(h.fr!.ref.url);
    expect(hello().prompt_pack).toEqual({ lang: "fr-CI", version: "1.0.0" });
    expect(hello().a11y!.extended_time).toBe(true);
    expect(h.session.consentRecord).toMatchObject({
      lang: "fr-CI",
      extendedTime: true,
    });
  });

  it("keeps the host's extended time and screen reader when the consent leaves them off", async () => {
    const h = await setup({
      config: { accessibility: { extendedTime: true, screenReader: true } },
    });
    begin(h);
    await until(() => FakeSocket.all.length > 0);
    FakeSocket.all[0]!.open();
    expect(hello().a11y).toMatchObject({
      extended_time: true,
      screen_reader: true,
      captions: true,
    });
  });

  it("declined: consent_declined, and everything released at once", async () => {
    const h = await setup();
    const b = begin(h, false);
    await until(() => h.session.state === "consent");
    h.session.headless!.submitConsent(false, "en-NG", false);
    await until(() => b.result.ok === false);
    expect(b.result.error).toMatchObject({
      code: "consent_declined",
      recoverable: true,
    });
    expect(h.types()).toEqual(["error", "closed"]);
    expect(h.telemetry.map((e) => e.name)).toContain("consent_result");
    expect(h.media.getUserMedia).not.toHaveBeenCalled();
    expect(h.ctx()).toBeUndefined();
  });
});

describe("carry-over to a redial (5.2)", () => {
  const prior = (o: { age?: number; lang?: string } = {}) => ({
    atMsWall: Date.now() - (o.age ?? 5 * 60000),
    lang: o.lang ?? "en-NG",
    extendedTime: true,
  });

  it("within 10 minutes in the same language: no consent screen, the original time in hello", async () => {
    const p = prior();
    const h = await setup({ config: { priorConsent: p } });
    const b = begin(h, false);
    // The redial's tap unlocked audio in start().
    expect(h.ctx()).toBeDefined();
    await until(() => FakeSocket.all.length > 0);
    FakeSocket.all[0]!.open();
    const states = h.events.flatMap((e) =>
      e.type === "state_changed" ? [e.to] : [],
    );
    expect(states).not.toContain("consent");
    expect(h.session.consentRecord).toEqual(p);
    expect(hello().consent.at_ms_wall).toBe(p.atMsWall);
    expect(hello().a11y!.extended_time).toBe(true);
    expect(h.telemetry.map((e) => e.name)).not.toContain("consent_shown");
    expect(b.result.ok).toBeUndefined();
  });

  it("in another offered language: that language's pack, no consent screen", async () => {
    const h = await setup({
      french: true,
      config: { priorConsent: prior({ lang: "fr-CI" }) },
    });
    begin(h, false);
    await until(() => FakeSocket.all.length > 0);
    FakeSocket.all[0]!.open();
    expect(hello().prompt_pack.lang).toBe("fr-CI");
  });

  it.each([
    ["older than 10 minutes", { age: 10 * 60000 + 1 }],
    ["in a language this session does not offer", { lang: "sw-KE" }],
    ["from the future", { age: -60000 }],
  ])("%s: the consent screen again", async (_what, o) => {
    const h = await setup({ config: { priorConsent: prior(o) } });
    begin(h, false);
    await until(() => h.session.state === "consent");
    expect(h.ctx()).toBeUndefined();
  });
});
