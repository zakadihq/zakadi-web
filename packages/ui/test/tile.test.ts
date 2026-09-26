import { afterEach, describe, expect, it, vi } from "vitest";
import { hsl } from "../src/color";
import { NEUTRAL } from "../src/element";
import { CSS } from "../src/styles";
import { bound, fakeBridge, rule, uiState, viewOf, type Hsl } from "./fakes";

// The nonce tile of spec/06-web-sdk.md 6.4.3 and spec/05-sdk-contract.md 5.8: `tile`
// paints the palette colour in its handler, with no transition and no governor, and
// before the first `tile` the tile is a neutral grey.
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

describe("the tile", () => {
  it("is a neutral grey before the first tile, the session's own fallback colour", () => {
    const { fake, $ } = bound(viewOf("call"));
    fake.ui(uiState());
    expect(NEUTRAL).toEqual([0, 0, 50]);
    expect($(".tile").style.backgroundColor).toBe("hsl(0, 0%, 50%)");
  });

  it("repaints the whole tile in the same task, the band included, as hsl()", () => {
    const { fake, $ } = bound(viewOf("call"));
    for (const [symbol, c] of PALETTE.entries()) {
      fake.tile(symbol, c);
      // Synchronously: nothing awaited between the handler and this read.
      expect($(".tile").style.backgroundColor).toBe(hsl(c));
    }
    expect(hsl([200, 94, 47])).toBe("hsl(200, 94%, 47%)");
  });

  it("has no transition and no governor: every tile lands, however fast", () => {
    vi.useFakeTimers();
    const { fake, $ } = bound(viewOf("call"));
    expect(rule(CSS, ".tile").transition).toBe("none");
    expect($(".tile").style.transition).toBe("");
    for (const [symbol, c] of PALETTE.entries()) {
      fake.tile(symbol, c);
      expect($(".tile").style.backgroundColor).toBe(hsl(c));
    }
  });

  it("goes back to the neutral grey for the next session", () => {
    const { el, fake, $ } = bound(viewOf("call"));
    fake.tile(4, PALETTE[4]!);
    el.unbindSession(fake.bridge);
    el.bindSession(fakeBridge(viewOf("call")).bridge);
    expect($(".tile").style.backgroundColor).toBe("hsl(0, 0%, 50%)");
  });
});
