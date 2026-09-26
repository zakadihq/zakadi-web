import { afterEach, describe, expect, it, vi } from "vitest";
import { CSS } from "../src/styles";
import {
  bound,
  builtin,
  fakeBridge,
  mount,
  PKG,
  TERMINALS,
  uiState,
  viewOf,
} from "./fakes";

// The element of spec/06-web-sdk.md 6.4.1: an autonomous custom element with an open
// shadow root, constructable stylesheets with a `<style>` fallback, DOM built without
// HTML strings, the theme custom properties, colours written through the CSSOM, and
// bubbling, composed events.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.textContent = "";
});

const fs = builtin<{
  readdirSync(dir: string): string[];
  readFileSync(file: string, enc: "utf8"): string;
}>("node:fs");
const src = PKG + "src/";

/** Every screen, a `ui` state and a tile, rendered through one bridge. */
function everyScreen() {
  const { el, fake } = bound(viewOf("consent"));
  for (const s of ["permission", "connecting", "call", ...TERMINALS] as const) {
    fake.show(viewOf(s, { character: null }));
    fake.ui(uiState({ digits: { visible: true, values: [4, 7] } }));
    fake.tile(2, [156, 97, 34]);
    fake.say("Hi.");
  }
  return el;
}

describe("the shadow root and its styles", () => {
  it("is open and adopts one constructable stylesheet, shared by every element", () => {
    const a = mount();
    const b = mount();
    expect(a.shadowRoot?.mode).toBe("open");
    expect(a.shadowRoot!.adoptedStyleSheets).toHaveLength(1);
    expect(a.shadowRoot!.adoptedStyleSheets[0]).toBe(
      b.shadowRoot!.adoptedStyleSheets[0],
    );
    expect(a.shadowRoot!.querySelector("style")).toBeNull();
  });

  it("falls back to a <style> element where stylesheets cannot be constructed", () => {
    vi.stubGlobal("CSSStyleSheet", undefined);
    const el = mount();
    const style = el.shadowRoot!.querySelector("style");
    expect(style?.textContent).toBe(CSS);
    expect(el.shadowRoot!.adoptedStyleSheets ?? []).toHaveLength(0);
  });
});

describe("the DOM (Trusted Types safe)", () => {
  it("never names an HTML-string API in its sources", () => {
    for (const file of fs.readdirSync(src))
      expect(fs.readFileSync(src + file, "utf8")).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|srcdoc/,
      );
  });

  it("never parses HTML while it renders every screen", () => {
    const parsed: string[] = [];
    const probe = document.createElement("div");
    for (const prop of ["innerHTML", "outerHTML"]) {
      let proto: object | null = probe;
      while (proto && !Object.getOwnPropertyDescriptor(proto, prop))
        proto = Object.getPrototypeOf(proto);
      const d = Object.getOwnPropertyDescriptor(proto!, prop)!;
      vi.spyOn(proto as never, prop as never, "set").mockImplementation(
        function (this: Element, v: string) {
          parsed.push(prop);
          d.set!.call(this, v);
        },
      );
    }
    vi.spyOn(Element.prototype, "insertAdjacentHTML").mockImplementation(() =>
      parsed.push("insertAdjacentHTML"),
    );
    everyScreen();
    expect(parsed).toEqual([]);
  });
});

describe("theming (6.4.1)", () => {
  it("reads the six --lv-* properties", () => {
    for (const p of [
      "--lv-color-primary",
      "--lv-color-on-primary",
      "--lv-color-text",
      "--lv-caption-bg",
      "--lv-font-family",
      "--lv-radius",
    ])
      expect(CSS).toContain(`var(${p},`);
  });

  it("takes ui.theme through the CSSOM, and brand.primary under the page's primary", () => {
    const { $ } = bound(
      viewOf("consent", {
        theme: { colorPrimary: "#123456", radius: "4px", fontFamily: "Inter" },
        brand: { primary: "#0A5", logo_url: null },
      }),
    );
    const zk = $(".zk");
    expect(zk.style.getPropertyValue("--lv-color-primary")).toBe("#123456");
    expect(zk.style.getPropertyValue("--lv-radius")).toBe("4px");
    expect(zk.style.getPropertyValue("--lv-font-family")).toBe("Inter");
    expect(zk.style.getPropertyValue("--lv-color-text")).toBe("");
    expect(zk.style.getPropertyValue("--zk-brand")).toBe("#0A5");
    expect(CSS).toContain(
      "--zk-primary:var(--lv-color-primary,var(--zk-brand,#0b57d0))",
    );
  });

  it("writes tile, surround and flood colours as CSSOM properties, never a style attribute", () => {
    const { fake, $ } = bound(viewOf("call"));
    fake.ui(uiState({ surround: { brightness: 1, flood: true } }));
    fake.tile(5, [243, 96, 76]);
    expect($(".zk").style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect($(".tile").style.backgroundColor).toBe("hsl(243, 96%, 76%)");
    // A style attribute or cssText is what CSP style-src blocks; neither is written.
    for (const file of fs.readdirSync(src))
      expect(fs.readFileSync(src + file, "utf8")).not.toMatch(
        /setAttribute\(\s*["']style|cssText|\.style\s*=/,
      );
  });

  it("exposes no part, on the tile, the surround, the self-view or elsewhere", () => {
    const el = everyScreen();
    expect(el.shadowRoot!.querySelectorAll("[part]")).toHaveLength(0);
  });
});

describe("events (6.4.1)", () => {
  it("dispatches zakadi-state, zakadi-redial and zakadi-close, bubbling and composed", () => {
    const got: Event[] = [];
    for (const type of ["zakadi-state", "zakadi-redial", "zakadi-close"])
      document.addEventListener(type, (e) => got.push(e));
    const { fake, $ } = bound(viewOf("consent"));
    fake.session.state = "error";
    fake.show(viewOf("interrupted"));
    $(".page:not([hidden]) .actions button:not(.primary)").click();
    $(".page:not([hidden]) .actions button.primary").click();
    expect(got.map((e) => e.type)).toEqual([
      "zakadi-state",
      "zakadi-state",
      "zakadi-redial",
      "zakadi-close",
    ]);
    for (const e of got) {
      expect(e.bubbles).toBe(true);
      expect(e.composed).toBe(true);
    }
    expect((got[0] as CustomEvent).detail).toEqual({
      screen: "consent",
      state: "idle",
    });
    expect((got[1] as CustomEvent).detail).toEqual({
      screen: "interrupted",
      state: "error",
    });
    expect(fake.spies.redial).toHaveBeenCalledOnce();
    expect(fake.spies.close).toHaveBeenCalledOnce();
  });
});

describe("binding (Z-047's contract)", () => {
  it("renders one bridge at a time and ignores another's unbind", () => {
    const el = mount();
    const first = fakeBridge(viewOf("consent"));
    const second = fakeBridge(viewOf("permission"));
    el.bindSession(first.bridge);
    expect(el.getAttribute("data-screen")).toBe("consent");
    el.bindSession(second.bridge);
    expect(el.getAttribute("data-screen")).toBe("permission");
    first.show(viewOf("call"));
    el.unbindSession(first.bridge);
    expect(el.getAttribute("data-screen")).toBe("permission");
    el.unbindSession(second.bridge);
    expect(el.hasAttribute("data-screen")).toBe(false);
    second.show(viewOf("call"));
    expect(el.hasAttribute("data-screen")).toBe(false);
  });

  it("stays hidden while idle or unbound", () => {
    const el = mount();
    expect(CSS).toContain(":host{display:none}");
    expect(el.hasAttribute("data-screen")).toBe(false);
    const fake = fakeBridge(viewOf("idle"));
    el.bindSession(fake.bridge);
    expect(el.hasAttribute("data-screen")).toBe(false);
  });
});
