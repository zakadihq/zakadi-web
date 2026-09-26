import { afterEach, describe, expect, it, vi } from "vitest";
import { grey } from "../src/color";
import { SURROUND } from "../src/element";
import { governor } from "../src/governor";
import { bound, uiState, viewOf, visible } from "./fakes";

// The surround, `flood` and the flash governor of spec/06-web-sdk.md 6.4.2 and 6.4.3
// (spec/05-sdk-contract.md 5.8, WCAG 2.3.1).
afterEach(() => {
  vi.useRealTimers();
  document.body.textContent = "";
});

const surround = (brightness: number, flood = false) =>
  uiState({ surround: { brightness, flood } });

describe("the surround", () => {
  it("takes brightness as relative luminance and paints its sRGB grey (G5)", () => {
    // round(255 v), v = 12.92 Y at or below 0.0031308, else 1.055 Y^(1/2.4) - 0.055.
    expect(grey(0)).toBe("rgb(0, 0, 0)");
    expect(grey(0.0031308)).toBe("rgb(10, 10, 10)");
    expect(grey(0.2)).toBe("rgb(124, 124, 124)");
    expect(grey(0.5)).toBe("rgb(188, 188, 188)");
    expect(grey(0.9)).toBe("rgb(243, 243, 243)");
    expect(grey(1)).toBe("rgb(255, 255, 255)");
  });

  it("is 0.9 before the first ui, painted at once", () => {
    const { $ } = bound(viewOf("consent"));
    expect(SURROUND).toBe(0.9);
    expect($(".zk").style.backgroundColor).toBe("rgb(243, 243, 243)");
    expect($(".zk").style.transition).toBe("none");
  });

  it("changes through a 300 ms transition, and flood ramps to white over 600 ms", () => {
    vi.useFakeTimers();
    const { fake, $ } = bound(viewOf("call"));
    fake.ui(surround(0.5));
    expect($(".zk").style.backgroundColor).toBe("rgb(188, 188, 188)");
    expect($(".zk").style.transition).toBe("background-color 300ms linear");
    fake.ui(surround(1, true));
    expect($(".zk").style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect($(".zk").style.transition).toBe("background-color 600ms linear");
    // Flood leaves the self-view and the tile as they are.
    expect($(".self").style.backgroundColor).toBe("");
    expect($(".tile").style.backgroundColor).toBe("hsl(0, 0%, 50%)");
  });

  it("passes three luminance changes a second and then the latest", () => {
    vi.useFakeTimers();
    const { fake, $ } = bound(viewOf("call"));
    // The first paint, 0.9, is one of the three.
    fake.ui(surround(0.5));
    fake.ui(surround(0.6));
    const shown = $(".zk").style.backgroundColor;
    fake.ui(surround(0.7));
    fake.ui(surround(0.8));
    fake.ui(surround(0.2));
    expect($(".zk").style.backgroundColor).toBe(shown);
    vi.advanceTimersByTime(999);
    expect($(".zk").style.backgroundColor).toBe(shown);
    vi.advanceTimersByTime(1);
    expect($(".zk").style.backgroundColor).toBe(grey(0.2));
  });

  it("drops a waiting change when the shown value comes back", () => {
    vi.useFakeTimers();
    const { fake, $ } = bound(viewOf("call"));
    fake.ui(surround(0.5));
    fake.ui(surround(0.6));
    fake.ui(surround(0.3));
    fake.ui(surround(0.6));
    vi.advanceTimersByTime(2000);
    expect($(".zk").style.backgroundColor).toBe(grey(0.6));
  });
});

describe("the governor on other elements", () => {
  it("holds the dim overlay and the digits to three changes a second each", () => {
    vi.useFakeTimers();
    const { fake, $ } = bound(viewOf("call"));
    const dim = (fill: "dim" | "none", visible: boolean) =>
      fake.ui(
        uiState({
          self_view: { oval: true, fill },
          digits: { visible, values: [1, 2, 3] },
        }),
      );
    // Past the window of the first paint.
    vi.advanceTimersByTime(1000);
    dim("dim", true);
    dim("none", false);
    dim("dim", true);
    dim("none", false);
    expect($(".dim").style.opacity).toBe("0.4");
    expect(visible($(".digits"))).toBe(true);
    vi.advanceTimersByTime(1000);
    expect($(".dim").style.opacity).toBe("0");
    expect(visible($(".digits"))).toBe(false);
  });

  it("counts only changes, and the window slides", () => {
    vi.useFakeTimers();
    const applied: number[] = [];
    const g = governor<number>((v) => applied.push(v), String);
    for (const v of [1, 1, 2, 2, 3]) g.set(v);
    expect(applied).toEqual([1, 2, 3]);
    g.set(4);
    vi.advanceTimersByTime(500);
    g.set(5);
    vi.advanceTimersByTime(500);
    expect(applied).toEqual([1, 2, 3, 5]);
    g.reset();
    g.set(6);
    expect(applied).toEqual([1, 2, 3, 5, 6]);
  });
});
