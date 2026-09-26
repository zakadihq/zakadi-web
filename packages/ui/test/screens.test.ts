import { TERMINAL_STATES } from "@zakadi/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { bound, STRINGS, TERMINALS, uiState, viewOf, visible } from "./fakes";

// The local screens and terminal states of spec/06-web-sdk.md 6.4.6 and
// spec/05-sdk-contract.md 5.8, rendered from the renderer bridge; consent before the
// camera (5.1).
afterEach(() => {
  document.body.textContent = "";
});

const shownText = (els: HTMLElement[]) =>
  els.filter(visible).map((e) => e.textContent);

describe("consent", () => {
  it("shows the copy, the brightness instruction, Listen, the accessibility options, Start and No thanks", () => {
    const { $, $$ } = bound(
      viewOf("consent", {
        brand: { primary: "#0A5", logo_url: "https://rp.example/logo.png" },
      }),
    );
    const page = $("section.page:not([hidden])");
    expect(page.querySelector("h2")!.textContent).toBe("A short video check");
    expect(page.textContent).toContain("Follow two prompts on camera.");
    expect(page.textContent).toContain("Turn your screen brightness up.");
    expect(page.textContent).toContain("Two still frames are kept for 7 days.");
    expect($<HTMLImageElement>(".logo").src).toBe(
      "https://rp.example/logo.png",
    );
    expect($("summary").textContent).toBe("Accessibility options");
    expect($$("label.check span").map((s) => s.textContent)).toEqual([
      "Guide me by voice",
      "Give me more time",
    ]);
    expect(shownText($$("section.page:not([hidden]) button"))).toEqual([
      "Listen",
      "No thanks",
      "Start",
    ]);
    // One language: no switcher.
    expect(visible($(".lang"))).toBe(false);
  });

  it("calls submitConsent synchronously from the Start tap, with the extended-time choice", () => {
    const { fake, $, $$ } = bound(viewOf("consent"));
    const [, extended] = $$<HTMLInputElement>("label.check input");
    extended!.click();
    let during = -1;
    fake.spies.submitConsent.mockImplementation(() => {
      during = fake.spies.submitConsent.mock.calls.length;
    });
    $("button.primary").click();
    // Called inside the click handler, before click() returned.
    expect(during).toBe(1);
    expect(fake.spies.submitConsent).toHaveBeenCalledWith(true, "en-NG", true);
  });

  it("declines with No thanks, plays the notice with Listen, and sets screen-reader mode", () => {
    const { fake, $, $$ } = bound(viewOf("consent"));
    const buttons = $$<HTMLButtonElement>("section.page:not([hidden]) button");
    buttons.find((b) => b.textContent === "No thanks")!.click();
    expect(fake.spies.submitConsent).toHaveBeenCalledWith(
      false,
      "en-NG",
      false,
    );
    buttons.find((b) => b.textContent === "Listen")!.click();
    expect(fake.spies.listen).toHaveBeenCalledOnce();
    $$<HTMLInputElement>("label.check input")[0]!.click();
    expect(fake.spies.setScreenReader).toHaveBeenCalledWith(true);
    expect(visible($(".notice"))).toBe(true);
  });

  it("offers the language switcher when the session lists several languages", () => {
    const { fake, $ } = bound(
      viewOf("consent", { languages: ["en-NG", "fr-CI"] }),
    );
    const select = $<HTMLSelectElement>(".lang select");
    expect(visible(select)).toBe(true);
    expect([...select.options].map((o) => o.value)).toEqual(["en-NG", "fr-CI"]);
    expect(select.value).toBe("en-NG");
    select.value = "fr-CI";
    select.dispatchEvent(new Event("change"));
    expect(fake.spies.selectLanguage).toHaveBeenCalledWith("fr-CI");
    fake.show(
      viewOf("consent", { languages: ["en-NG", "fr-CI"], lang: "fr-CI" }),
    );
    expect(select.value).toBe("fr-CI");
  });

  it("hides Listen without a recording notice", () => {
    const { $ } = bound(
      viewOf("consent", { consentCopy: { title: "T", body: "B" } }),
    );
    expect(visible($(".notice"))).toBe(false);
  });

  it("opens no camera: the preview stays empty before connecting (5.1)", () => {
    const { fake, $ } = bound(viewOf("consent"));
    fake.show(viewOf("permission"));
    expect(fake.spies.previewStream).not.toHaveBeenCalled();
    expect($<HTMLVideoElement>("video").srcObject ?? null).toBeNull();
  });
});

describe("permission and connecting", () => {
  it("explains the permission request", () => {
    const { $ } = bound(viewOf("permission"));
    const page = $("section.page:not([hidden])");
    expect(page.querySelector("h2")!.textContent).toBe(
      STRINGS.permission.title,
    );
    expect(page.textContent).toContain(STRINGS.permission.body);
  });

  it("rings with the preview, hidden while the camera probe runs, and a cancel", () => {
    const { fake, $, $$ } = bound(
      viewOf("connecting", { previewHidden: true }),
    );
    expect(visible($(".stage"))).toBe(true);
    expect($("video").style.visibility).toBe("hidden");
    expect($<HTMLVideoElement>("video").srcObject).toBe(fake.stream);
    expect(shownText($$(".controls button"))).toEqual(["Cancel"]);
    $$(".controls button").find(visible)!.click();
    expect(fake.spies.press).toHaveBeenCalledWith("cancel");
    fake.show(viewOf("connecting", { previewHidden: false }));
    expect($("video").style.visibility).toBe("visible");
  });

  it("shows the call from the first ui on", () => {
    const { fake, $ } = bound(viewOf("call"));
    fake.ui(uiState());
    expect(visible($(".stage"))).toBe(true);
    expect($(".caption").textContent).toBe("Hi.");
  });
});

describe("terminal states (5.8)", () => {
  it.each(TERMINALS)(
    "%s shows its caption and close, and redial only where 5.8 offers it",
    (state) => {
      const { fake, $, $$ } = bound(viewOf("call"));
      fake.show(viewOf(state));
      const page = $("section.page:not([hidden])");
      expect(page.querySelector("h2")!.textContent).toBe(STRINGS.end[state]);
      const offered = [
        "incomplete",
        "disconnected",
        "network_floor",
        "error",
        "interrupted",
      ].includes(state);
      expect(TERMINAL_STATES[state].offersRedial).toBe(offered);
      expect(shownText($$("section.page:not([hidden]) button"))).toEqual(
        offered ? ["Call again", "Close"] : ["Close"],
      );
      expect(visible($(".stage"))).toBe(false);
      expect($<HTMLVideoElement>("video").srcObject).toBeNull();
    },
  );

  it("shows the server's message for sdk_disabled and the guidance for an unsupported browser", () => {
    const { fake, $ } = bound(viewOf("call"));
    fake.show(viewOf("sdk_disabled", { message: "Update the app." }));
    expect($("section.page:not([hidden])").textContent).toContain(
      "Update the app.",
    );
    fake.show(viewOf("unsupported_device"));
    expect($("section.page:not([hidden])").textContent).toContain(
      STRINGS.unsupported.body,
    );
  });
});

describe("the badge (5.8)", () => {
  it("is shown on every screen, never hidden", () => {
    const { fake, $ } = bound(viewOf("consent"));
    for (const s of [
      "consent",
      "permission",
      "connecting",
      "call",
      ...TERMINALS,
    ] as const) {
      fake.show(viewOf(s));
      fake.ui(uiState({ badge: "automated" }));
      expect(visible($(".badge"))).toBe(true);
      expect($(".badge").textContent).toBe(STRINGS.badge);
    }
  });

  it("carries sessionUi.badge_text as the session resolves it", () => {
    const { $ } = bound(
      viewOf("call", {
        strings: { ...STRINGS, badge: "Verification by Acme" },
      }),
    );
    expect($(".badge").textContent).toBe("Verification by Acme");
  });
});
