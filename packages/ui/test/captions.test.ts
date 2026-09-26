import { afterEach, describe, expect, it, vi } from "vitest";
import { CSS } from "../src/styles";
import { bound, uiState, viewOf, visible } from "./fakes";

// The caption bar and the listening ring of spec/06-web-sdk.md 6.4.2 and
// spec/05-sdk-contract.md 5.8: `ui.caption` in the bar, `say.caption` announced and shown
// only when the bar has no text of its own (G6); the ring moves, never changes luminance.
afterEach(() => {
  vi.useRealTimers();
  document.body.textContent = "";
});

const caption = (text: string, pictogram?: string) =>
  uiState({ caption: pictogram ? { text, pictogram } : { text } });

describe("captions", () => {
  it("shows ui.caption, naming its pictogram in a data attribute and drawing none (D96)", () => {
    const { fake, $ } = bound(viewOf("call"));
    fake.ui(caption("Turn your head slowly, like this.", "head_turn_left"));
    const bar = $(".caption");
    expect(bar.textContent).toBe("Turn your head slowly, like this.");
    expect(bar.getAttribute("data-pictogram")).toBe("head_turn_left");
    expect(bar.children).toHaveLength(0);
    expect(visible(bar)).toBe(true);
    fake.ui(caption("Nice."));
    expect(bar.hasAttribute("data-pictogram")).toBe(false);
  });

  it("announces every say.caption through aria-live", () => {
    const { fake, $ } = bound(viewOf("call"));
    const live = $(".sr[aria-live]");
    expect(live.getAttribute("aria-live")).toBe("polite");
    fake.ui(caption("Hi."));
    fake.say("Hi. Quick automated check.");
    expect(live.textContent).toBe("Hi. Quick automated check.");
    fake.say("Hi. Quick automated check.");
    // The same words again are a new node, so they are announced again.
    expect(live.children).toHaveLength(1);
    fake.say();
    expect(live.textContent).toBe("Hi. Quick automated check.");
  });

  it("shows say.caption in the bar only while ui.caption.text is empty (G6)", () => {
    const { fake, $ } = bound(viewOf("call"));
    fake.ui(caption("Hi."));
    fake.say("Hi. Quick automated check.");
    expect($(".caption").textContent).toBe("Hi.");
    fake.ui(caption(""));
    expect($(".caption").textContent).toBe("Hi. Quick automated check.");
    fake.say("Perfect.");
    expect($(".caption").textContent).toBe("Perfect.");
    fake.ui(caption("Nice."));
    expect($(".caption").textContent).toBe("Nice.");
  });

  it("hides the bar when captions are off, and still announces", () => {
    const view = viewOf("call");
    const { fake, $ } = bound({
      ...view,
      a11y: { ...view.a11y, captions: false },
    });
    fake.ui(caption("Hi."));
    fake.say("Hi. Quick automated check.");
    expect(visible($(".caption"))).toBe(false);
    expect($(".sr[aria-live]").textContent).toBe("Hi. Quick automated check.");
  });

  it("says Calling... while connecting", () => {
    const { $ } = bound(viewOf("connecting"));
    expect($(".caption").textContent).toBe("Calling...");
  });
});

describe("the listening ring", () => {
  it("sweeps in listening by width and scale alone, its colour fixed", () => {
    const { fake, $ } = bound(viewOf("call"));
    fake.ui(uiState({ phase: "listening" }));
    expect($(".stage").getAttribute("data-phase")).toBe("listening");
    expect(CSS).toContain(
      ".stage[data-phase=listening] .ring{animation:zk-sweep 2.4s ease-in-out infinite}",
    );
    expect(CSS).toContain(
      "@keyframes zk-sweep{50%{transform:scale(1.015);border-width:6px}}",
    );
    const rules = CSS.split("\n").filter((r) => r.includes(".ring"));
    expect(rules.join()).not.toMatch(
      /opacity|filter|background|color:|visibility/,
    );
  });

  it("follows the playback envelope, low-passed, with transform and border-width only", () => {
    vi.useFakeTimers();
    const { fake, $ } = bound(viewOf("call"));
    const ring = $(".ring");
    let level = 0;
    fake.analyser = {
      getByteTimeDomainData: vi.fn((b: Uint8Array) =>
        b.forEach((_, i) => (b[i] = 128 + (i % 2 ? level : -level))),
      ),
    };
    fake.show(viewOf("call"));
    level = 8;
    vi.advanceTimersByTime(50);
    const early = parseFloat(ring.style.transform.slice(6));
    vi.advanceTimersByTime(1000);
    const late = parseFloat(ring.style.transform.slice(6));
    // A one-pole low-pass at 2.5 Hz: it rises over hundreds of milliseconds.
    expect(early).toBeGreaterThan(1);
    expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThanOrEqual(1.03);
    expect(parseFloat(ring.style.borderWidth)).toBeGreaterThan(3);
    // Only its geometry is written: no colour, opacity or background.
    const written = [...Array(ring.style.length).keys()].map((i) =>
      ring.style.item(i),
    );
    expect(written).toContain("transform");
    for (const p of written)
      expect(p).toMatch(/^(transform|border(-\w+)*-width)$/);
  });

  it("stands still under reduced motion", () => {
    vi.useFakeTimers();
    const view = viewOf("call");
    const { fake, $ } = bound({
      ...view,
      a11y: { ...view.a11y, reduced_motion: true },
    });
    fake.analyser = { getByteTimeDomainData: vi.fn() };
    fake.show({ ...fake.view });
    vi.advanceTimersByTime(500);
    expect(fake.analyser.getByteTimeDomainData).not.toHaveBeenCalled();
    expect($(".ring").style.transform).toBe("");
  });
});
