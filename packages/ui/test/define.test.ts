import { afterEach, describe, expect, it, vi } from "vitest";
import { defineZakadiCall } from "../src/index";

// Registration (spec/06-web-sdk.md 6.1.2, 6.5): only defineZakadiCall() or the
// `@zakadi/ui/define` entry registers `<zakadi-call>`, and a second call changes nothing.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("defineZakadiCall()", () => {
  it("registers <zakadi-call> and is idempotent", () => {
    expect(customElements.get("zakadi-call")).toBeUndefined();
    defineZakadiCall();
    const ctor = customElements.get("zakadi-call");
    expect(ctor).toBeTypeOf("function");
    expect(() => defineZakadiCall()).not.toThrow();
    expect(customElements.get("zakadi-call")).toBe(ctor);
    const el = document.createElement("zakadi-call");
    expect(el).toBeInstanceOf(ctor!);
    expect(el).toHaveProperty("bindSession");
    expect(el).toHaveProperty("unbindSession");
  });

  it("leaves a tag defined first by another copy as it is", () => {
    const registry = {
      get: vi.fn(() => class extends HTMLElement {}),
      define: vi.fn(),
    };
    vi.stubGlobal("customElements", registry);
    defineZakadiCall();
    expect(registry.define).not.toHaveBeenCalled();
  });

  it("does nothing where custom elements do not exist", () => {
    vi.stubGlobal("customElements", undefined);
    expect(() => defineZakadiCall()).not.toThrow();
  });
});

describe("@zakadi/ui/define", () => {
  it("calls defineZakadiCall() when imported", async () => {
    const registry = { get: vi.fn(() => undefined), define: vi.fn() };
    vi.stubGlobal("customElements", registry);
    await import("../src/define");
    expect(registry.define).toHaveBeenCalledOnce();
    expect(registry.define).toHaveBeenCalledWith(
      "zakadi-call",
      expect.any(Function),
    );
  });

  it("registers nothing when @zakadi/ui itself is imported", async () => {
    const registry = { get: vi.fn(() => undefined), define: vi.fn() };
    vi.stubGlobal("customElements", registry);
    await import("../src/index");
    expect(registry.define).not.toHaveBeenCalled();
  });
});
