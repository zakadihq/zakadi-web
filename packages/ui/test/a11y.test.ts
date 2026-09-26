import { afterEach, describe, expect, it } from "vitest";
import { contrast, parseColor, type Rgba } from "../src/color";
import { CAPTION } from "../src/element";
import { CSS } from "../src/styles";
import {
  bound,
  mount,
  rule,
  TERMINALS,
  uiState,
  viewOf,
  visible,
} from "./fakes";

// The call's accessibility (spec/06-web-sdk.md 6.2.10, spec/05-sdk-contract.md 5.10): a
// focus-trapped modal dialog, labelled buttons of at least 48 x 48 CSS px, and caption
// colours under 4.5:1 refused.
afterEach(() => {
  document.body.textContent = "";
});

const tab = (from: Element, shift = false) =>
  from.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: shift,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );

describe("the dialog", () => {
  it("is role=dialog with aria-modal, labelled by the badge", () => {
    const { $ } = bound(viewOf("consent"));
    const dialog = $(".zk");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const label = dialog.getAttribute("aria-labelledby")!;
    expect($(`#${label}`)).toBe($(".badge"));
  });

  it("moves focus into each screen as it opens", () => {
    const { el, fake, $ } = bound(viewOf("consent"));
    expect(el.shadowRoot!.activeElement).toBe(
      $("section.page:not([hidden]) h2"),
    );
    fake.show(viewOf("call"));
    expect(el.shadowRoot!.activeElement).toBe($(".stage"));
    fake.show(viewOf("completed"));
    expect(el.shadowRoot!.activeElement).toBe(
      $("section.page:not([hidden]) h2"),
    );
  });

  it("traps Tab and Shift+Tab inside the dialog", () => {
    const { el, $$ } = bound(viewOf("consent"));
    const items = $$(
      "section.page:not([hidden]) :is(button, select, input, summary)",
    ).filter(visible);
    const first = items[0]!;
    const last = items[items.length - 1]!;
    last.focus();
    expect(tab(last)).toBe(false);
    expect(el.shadowRoot!.activeElement).toBe(first);
    expect(tab(first, true)).toBe(false);
    expect(el.shadowRoot!.activeElement).toBe(last);
    // Between the ends, Tab takes its native course.
    items[1]!.focus();
    expect(tab(items[1]!)).toBe(true);
  });

  it("takes focus back from the page while open, and lets it go once unbound", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const { el, fake } = bound(viewOf("consent"));
    outside.focus();
    expect(document.activeElement).toBe(el);
    el.unbindSession(fake.bridge);
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });

  it("leaves focus to another open call", () => {
    const a = bound(viewOf("consent"));
    const b = bound(viewOf("consent"));
    expect(document.activeElement).toBe(b.el);
    a.$("button.primary").focus();
    expect(document.activeElement).toBe(a.el);
  });
});

describe("controls", () => {
  it("are labelled buttons of at least 48 x 48 CSS px", () => {
    const { fake, el } = bound(viewOf("consent"));
    const labels: string[] = [];
    for (const s of ["consent", "connecting", "call", ...TERMINALS] as const) {
      fake.show(viewOf(s));
      fake.ui(uiState());
      for (const b of el.shadowRoot!.querySelectorAll("button"))
        if (visible(b)) labels.push(b.textContent ?? "");
    }
    expect(labels.length).toBeGreaterThan(10);
    for (const l of labels) expect(l.trim()).not.toBe("");
    const sized = rule(CSS, "button,select,summary");
    expect(sized["min-width"]).toBe("48px");
    expect(sized["min-height"]).toBe("48px");
    expect(rule(CSS, ".check")["min-height"]).toBe("48px");
  });
});

describe("caption colours (6.2.10)", () => {
  const withTheme = (theme: Record<string, string>) =>
    bound(viewOf("call", { theme })).$(".caption");

  it("keep a theme pair of 4.5:1 or more", () => {
    const bar = withTheme({ colorText: "#1a1a1a", captionBg: "#f0f0f0" });
    expect(bar.hasAttribute("data-refused")).toBe(false);
    expect(bar.style.getPropertyValue("--zk-cap-fg")).toBe("");
  });

  it("refuse a pair under 4.5:1 for the built-in pair", () => {
    for (const theme of [
      { colorText: "#777777", captionBg: "#ffffff" },
      { colorText: "#ffffff", captionBg: "#ffff00" },
      { colorText: "rgb(0 0 0 / 30%)", captionBg: "#fff" },
      { colorText: "not-a-colour", captionBg: "#fff" },
    ]) {
      const bar = withTheme(theme);
      expect(bar.hasAttribute("data-refused")).toBe(true);
      expect(bar.style.getPropertyValue("--zk-cap-fg")).toBe(CAPTION.text);
      expect(bar.style.getPropertyValue("--zk-cap-bg")).toBe(CAPTION.bg);
    }
    const [fg, bg] = [parseColor(CAPTION.text), parseColor(CAPTION.bg)];
    expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
  });

  it("read the page's --lv-* tokens too", () => {
    const el = mount();
    el.style.setProperty("--lv-color-text", "#bbbbbb");
    const { $ } = {
      $: (s: string) => el.shadowRoot!.querySelector<HTMLElement>(s)!,
    };
    el.bindSession(bound(viewOf("call")).fake.bridge);
    expect($(".caption").hasAttribute("data-refused")).toBe(true);
  });

  it("measure WCAG contrast", () => {
    const c = (a: string, b: string) =>
      contrast(parseColor(a) as Rgba, parseColor(b) as Rgba);
    expect(c("#000", "#fff")).toBeCloseTo(21, 5);
    expect(c("#777", "#fff")).toBeCloseTo(4.48, 2);
    expect(c("hsl(0, 0%, 100%)", "rgb(0, 0, 0)")).toBeCloseTo(21, 5);
    expect(parseColor("#0a5f")).toEqual([0, 170, 85, 1]);
    expect(parseColor("rgba(255, 0, 0, 0.5)")).toEqual([255, 0, 0, 0.5]);
    expect(parseColor("white")).toEqual([255, 255, 255, 1]);
    expect(parseColor("color-mix(in srgb, red, blue)")).toBeNull();
  });
});
