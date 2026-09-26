import { afterEach, describe, expect, it, vi } from "vitest";
import { contrast, parseColor } from "../src/color";
import { ARROWS, H, OVAL, W, type Direction } from "../src/guide";
import { CSS } from "../src/styles";
import { bound, rule, uiState, viewOf, visible } from "./fakes";

// The layout of spec/05-sdk-contract.md 5.8 and spec/06-web-sdk.md 6.4.2, with the
// `ui` fields of spec/01-protocol.md 1.5, in the coordinates of the encoded frame.
afterEach(() => {
  vi.useRealTimers();
  document.body.textContent = "";
});

const pct = (v: string) => parseFloat(v);

describe("the self-view and the guide", () => {
  it("fits the portrait layout into a landscape area, at most 3:4 (6.4.2, 6.8)", () => {
    const frame = rule(CSS, ".frame");
    expect(frame["max-width"]).toBe("calc(100dvh * 3 / 4)");
    expect(CSS).toContain(
      "max-width:calc(100vh * 3 / 4);max-width:calc(100dvh",
    );
    expect(frame.margin).toBe("0 auto");
    const { $ } = bound(viewOf("call"));
    expect($(".frame").parentElement).toBe($(".zk"));
    expect($(".frame > .stage")).not.toBeNull();
  });

  it("is 75 % of the height, mirrored and cropped like object-fit: cover", () => {
    expect(rule(CSS, ".self")).toMatchObject({ top: "7%", height: "75%" });
    expect(rule(CSS, ".self video")).toEqual({
      "object-fit": "cover",
      transform: "scaleX(-1)",
    });
  });

  it("draws the oval and the arc in one unmirrored SVG over the encoded frame", () => {
    const { $ } = bound(viewOf("call"));
    const svg = $<SVGSVGElement>(".self svg");
    expect([W, H]).toEqual([480, 640]);
    expect(svg.getAttribute("viewBox")).toBe("0 0 480 640");
    // slice crops exactly like the video's object-fit: cover (6.4.2).
    expect(svg.getAttribute("preserveAspectRatio")).toBe("xMidYMid slice");
    expect(svg.hasAttribute("transform")).toBe(false);
    expect(svg.querySelector(".oval")).not.toBeNull();
    expect(svg.querySelectorAll(".shaft")).toHaveLength(4);
  });

  it("places the oval at 0.5 W, 0.55 W wide, its top at 0.18 H, 1.3 x as high as wide (G3)", () => {
    const { $ } = bound(viewOf("call"));
    const oval = $(".oval");
    const n = (a: string) => Number(oval.getAttribute(a));
    expect(n("cx")).toBeCloseTo(0.5 * W, 1);
    expect(2 * n("rx")).toBeCloseTo(0.55 * W, 1);
    expect(n("cy") - n("ry")).toBeCloseTo(0.18 * H, 1);
    expect(n("ry") / n("rx")).toBeCloseTo(1.3, 3);
    expect(OVAL).toEqual({ cx: 240, cy: 286.8, rx: 132, ry: 171.6 });
  });

  it("shows the oval, thickens it for highlight and dims outside it for fill: dim", () => {
    vi.useFakeTimers();
    const { fake, $ } = bound(viewOf("call"));
    fake.ui(uiState());
    expect(visible($(".oval"))).toBe(true);
    expect($(".oval").classList.contains("hl")).toBe(false);
    expect($(".dim").style.opacity).toBe("0");
    fake.ui(
      uiState({
        self_view: { oval: true, oval_emphasis: "highlight", fill: "dim" },
      }),
    );
    expect($(".oval").classList.contains("hl")).toBe(true);
    expect(rule(CSS, ".oval.hl")["stroke-width"]).toBe("9");
    expect(rule(CSS, ".oval")["stroke-width"]).toBe("4");
    // A 40 % black overlay; the oval itself is cut out of it (even-odd).
    expect($(".dim").style.opacity).toBe("0.4");
    expect($(".dim").getAttribute("fill-rule")).toBe("evenodd");
    fake.ui(uiState({ self_view: { oval: false } }));
    expect(visible($(".oval"))).toBe(false);
  });
});

describe("the arc (1.5 direction semantics)", () => {
  const ends = (d: Direction) =>
    ARROWS[d].map((a) => {
      const pts = a.d
        .slice(1)
        .split("L")
        .map((p) => p.split(" ").map(Number) as [number, number]);
      return { start: pts[0]!, end: pts[pts.length - 1]! };
    });
  const r = ([x, y]: [number, number]) =>
    Math.hypot((x - OVAL.cx) / OVAL.rx, (y - OVAL.cy) / OVAL.ry);

  it("points user_left to screen-left and user_right to screen-right, unmirrored", () => {
    const [left] = ends("user_left");
    const [right] = ends("user_right");
    expect(left!.end[0]).toBeLessThan(OVAL.cx);
    expect(left!.end[0]).toBeLessThan(left!.start[0]);
    expect(right!.end[0]).toBeGreaterThan(OVAL.cx);
    expect(right!.end[0]).toBeGreaterThan(right!.start[0]);
  });

  it("points up above the oval, down below it, closer outward and further inward", () => {
    const [up] = ends("up");
    const [down] = ends("down");
    expect(up!.end[1]).toBeLessThan(up!.start[1]);
    expect(up!.start[1]).toBeLessThan(OVAL.cy - OVAL.ry);
    expect(down!.end[1]).toBeGreaterThan(down!.start[1]);
    expect(down!.start[1]).toBeGreaterThan(OVAL.cy + OVAL.ry);
    for (const a of ends("closer"))
      expect(r(a.end)).toBeGreaterThan(r(a.start));
    for (const a of ends("further")) expect(r(a.end)).toBeLessThan(r(a.start));
    expect(ends("closer")).toHaveLength(4);
  });

  it("draws the direction's shafts along progress, with their heads", () => {
    const { fake, $, $$ } = bound(viewOf("call"));
    fake.ui(
      uiState({ arc: { visible: true, direction: "closer", progress: 0.25 } }),
    );
    const shafts = $$<SVGPathElement>(".shaft");
    expect(shafts.filter(visible)).toHaveLength(4);
    shafts.forEach((p, i) => {
      const a = ARROWS.closer[i]!;
      expect(p.getAttribute("d")).toBe(a.d);
      expect(Number(p.style.strokeDasharray)).toBe(a.length);
      expect(Number(p.style.strokeDashoffset)).toBeCloseTo(0.75 * a.length, 5);
    });
    expect($(".heads").getAttribute("d")).toBe(
      ARROWS.closer.map((a) => a.head).join(""),
    );
    fake.ui(
      uiState({ arc: { visible: true, direction: "user_right", progress: 1 } }),
    );
    expect(shafts.filter(visible)).toHaveLength(1);
    expect(Number(shafts[0]!.style.strokeDashoffset)).toBe(0);
    fake.ui(uiState({ arc: { visible: false, direction: "user_right" } }));
    expect(shafts.filter(visible)).toHaveLength(0);
    expect(visible($(".heads"))).toBe(false);
  });

  it("draws the arc complete under reduced motion (6.4.4)", () => {
    const view = viewOf("call");
    const { fake, $ } = bound({
      ...view,
      a11y: { ...view.a11y, reduced_motion: true },
    });
    fake.ui(
      uiState({
        arc: { visible: true, direction: "user_left", progress: 0.1 },
      }),
    );
    expect($(".shaft").style.strokeDashoffset).toBe("0");
  });
});

describe("the host tile (5.8, D6)", () => {
  it("is 22 % of the width by 26 % of the height at the top right", () => {
    const tile = rule(CSS, ".tile");
    expect(tile).toMatchObject({ width: "22%", height: "26%", top: "7%" });
    expect(pct(tile.left!) + pct(tile.width!)).toBeLessThanOrEqual(100);
    expect(pct(tile.left!)).toBeGreaterThanOrEqual(
      pct(rule(CSS, ".self").left!) + pct(rule(CSS, ".self").width!),
    );
  });

  it("keeps the character in its lower 14 %, leaving the upper 12 % a flat band", () => {
    const box = rule(CSS, ".character");
    expect(box).toMatchObject({ bottom: "0", overflow: "hidden" });
    expect(pct(box.height!) / 100).toBeCloseTo(14 / 26, 3);
    const { $ } = bound(viewOf("call"));
    expect($(".tile").children).toHaveLength(1);
    expect($(".tile").firstElementChild!.className).toBe("character");
  });
});

describe("digits, controls and progress (5.8, 6.4.2)", () => {
  it("shows one box per value, each at least 15 % of the element's width, on a 4.5:1 backing", () => {
    vi.useFakeTimers();
    const { fake, $, $$ } = bound(viewOf("call"));
    fake.ui(uiState({ digits: { visible: true, values: [4, 7, 2, 9] } }));
    expect(visible($(".digits"))).toBe(true);
    expect($$(".digit").map((d) => d.textContent)).toEqual([
      "4",
      "7",
      "2",
      "9",
    ]);
    // Each box's share of the element: its width of the 72 % digits row.
    const digit = rule(CSS, ".digit");
    const row = rule(CSS, ".digits");
    expect((pct(digit.width!) * pct(row.width!)) / 100).toBeGreaterThanOrEqual(
      15,
    );
    expect(digit["font-variant-numeric"]).toBe("tabular-nums");
    expect(
      contrast(
        parseColor(digit.color!)!,
        parseColor(digit["background-color"]!)!,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    vi.advanceTimersByTime(1000);
    fake.ui(uiState({ digits: { visible: false, values: [4, 7, 2, 9] } }));
    expect(visible($(".digits"))).toBe(false);
  });

  it("shows the controls ui.controls enables and forwards each press", () => {
    const { fake, $$ } = bound(viewOf("call"));
    fake.ui(
      uiState({ controls: { repeat: true, more_time: false, cancel: true } }),
    );
    const shown = $$<HTMLButtonElement>(".controls button").filter(visible);
    expect(shown.map((b) => b.textContent)).toEqual(["Repeat", "Cancel"]);
    for (const b of shown) b.click();
    expect(fake.spies.press.mock.calls).toEqual([["repeat"], ["cancel"]]);
  });

  it("always offers more time with extended time (5.10)", () => {
    const view = viewOf("call");
    const { fake, $$ } = bound({
      ...view,
      a11y: { ...view.a11y, extended_time: true },
    });
    fake.ui(
      uiState({ controls: { repeat: false, more_time: false, cancel: false } }),
    );
    expect(
      $$(".controls button")
        .filter(visible)
        .map((b) => b.textContent),
    ).toEqual(["More time"]);
  });

  it("marks progress.step of progress.of dots", () => {
    const { fake, $, $$ } = bound(viewOf("call"));
    fake.ui(uiState({ progress: { step: 1, of: 3 } }));
    expect($$(".dot")).toHaveLength(3);
    expect($$(".dot").map((d) => d.classList.contains("on"))).toEqual([
      true,
      false,
      false,
    ]);
    expect($(".dots").getAttribute("role")).toBe("progressbar");
    expect($(".dots").getAttribute("aria-valuenow")).toBe("1");
    expect($(".dots").getAttribute("aria-valuemax")).toBe("3");
    const without = uiState();
    delete without.progress;
    fake.ui(without);
    expect(visible($(".dots"))).toBe(false);
  });
});
