import { afterEach, describe, expect, it, vi } from "vitest";
import { hsl, luminance, parseColor } from "../src/color";
import { NEUTRAL } from "../src/element";
import { CSS } from "../src/styles";
import { bound, fakeBridge, rule, uiState, viewOf, type Hsl } from "./fakes";

// The nonce tile of spec/06-web-sdk.md 6.4.3 and spec/05-sdk-contract.md 5.8: `tile`
// paints the palette colour in its handler, with no transition and no governor, and
// before the first `tile` the tile is the neutral grey at the palette's luminance (G4),
// hsl(0, 0%, 50%) only while the view carries no palette.
afterEach(() => {
  vi.useRealTimers();
  document.body.textContent = "";
});

// The tile palette of zakadi-content, eight isoluminant hues.
const PALETTE: Hsl[] = [
  [34, 45, 52],
  [65, 99, 31],
  [156, 97, 34],
  [182, 97, 34],
  [200, 94, 47],
  [243, 96, 76],
  [296, 100, 63],
  [348, 54, 66],
];
/** Its grey: the lightness of the relative luminance its entries share, about 0.30. */
const GREY = "hsl(0, 0%, 58.4%)";
const y = (css: string) => luminance(parseColor(css)!);

describe("the tile", () => {
  it("is hsl(0, 0%, 50%) before the first tile while the palette is empty", () => {
    expect(NEUTRAL).toEqual([0, 0, 50]);
    for (const v of [viewOf("call"), viewOf("call", { palette: [] })]) {
      const { fake, $ } = bound(v);
      fake.ui(uiState());
      expect($(".tile").style.backgroundColor).toBe("hsl(0, 0%, 50%)");
    }
  });

  it("is the neutral grey at the palette's luminance before the first tile (G4)", () => {
    const { fake, $ } = bound(viewOf("call", { palette: PALETTE }));
    fake.ui(uiState());
    const band = $(".tile").style.backgroundColor;
    expect(band).toBe(GREY);
    // Within the entries' own luminances, so the first tile is no luminance step; the
    // grey of 50% lies 0.08 below them.
    const ys = PALETTE.map((c) => y(hsl(c)));
    expect(y(band)).toBeGreaterThanOrEqual(Math.min(...ys));
    expect(y(band)).toBeLessThanOrEqual(Math.max(...ys));
    expect(Math.min(...ys) - y("hsl(0, 0%, 50%)")).toBeGreaterThan(0.08);
  });

  it("takes the palette from the view that brings it, until the first tile", () => {
    const { fake, $ } = bound(viewOf("connecting"));
    expect($(".tile").style.backgroundColor).toBe("hsl(0, 0%, 50%)");
    // The pack loads while the call connects: the view changes, the tile turns grey.
    fake.show(viewOf("connecting", { palette: PALETTE }));
    expect($(".tile").style.backgroundColor).toBe(GREY);
    fake.show(viewOf("call", { palette: PALETTE }));
    expect($(".tile").style.backgroundColor).toBe(GREY);
    fake.tile(3, PALETTE[3]!);
    expect($(".tile").style.backgroundColor).toBe(hsl(PALETTE[3]!));
    // Later views and `ui` states leave the tile's colour to the next tile.
    fake.show(viewOf("call", { palette: PALETTE, previewHidden: true }));
    fake.ui(uiState({ phase: "action" }));
    expect($(".tile").style.backgroundColor).toBe(hsl(PALETTE[3]!));
  });

  it("repaints the whole tile in the same task, the band included, as hsl()", () => {
    const { fake, $ } = bound(viewOf("call", { palette: PALETTE }));
    for (const [symbol, c] of PALETTE.entries()) {
      fake.tile(symbol, c);
      // Synchronously: nothing awaited between the handler and this read.
      expect($(".tile").style.backgroundColor).toBe(hsl(c));
    }
    expect(hsl([200, 94, 47])).toBe("hsl(200, 94%, 47%)");
  });

  it("has no transition and no governor: every tile lands, however fast", () => {
    vi.useFakeTimers();
    const { fake, $ } = bound(viewOf("call", { palette: PALETTE }));
    expect(rule(CSS, ".tile").transition).toBe("none");
    expect($(".tile").style.transition).toBe("");
    for (const [symbol, c] of PALETTE.entries()) {
      fake.tile(symbol, c);
      expect($(".tile").style.backgroundColor).toBe(hsl(c));
    }
    expect($(".tile").style.transition).toBe("");
  });

  it("goes back to the grey for the next session", () => {
    const { el, fake, $ } = bound(viewOf("call", { palette: PALETTE }));
    fake.tile(4, PALETTE[4]!);
    el.unbindSession(fake.bridge);
    const next = fakeBridge(viewOf("call", { palette: PALETTE }));
    el.bindSession(next.bridge);
    expect($(".tile").style.backgroundColor).toBe(GREY);
    next.tile(4, PALETTE[4]!);
    el.unbindSession(next.bridge);
    el.bindSession(fakeBridge(viewOf("call")).bridge);
    expect($(".tile").style.backgroundColor).toBe("hsl(0, 0%, 50%)");
  });
});
