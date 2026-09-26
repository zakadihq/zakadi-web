import { afterEach, describe, expect, it, vi } from "vitest";
import { rendererFor } from "../src/character";
import { bound, uiState, viewOf } from "./fakes";

// The character of spec/06-web-sdk.md 6.4.4 and spec/05-sdk-contract.md 5.7: lottie-web's
// light players, each loaded by dynamic import only once the session hands over the
// hash-checked Lottie JSON, and colour alone without one.
const lottie = vi.hoisted(() => {
  const make = (renderer: string) => {
    const items: {
      config: Record<string, unknown>;
      calls: [string, ...unknown[]][];
    }[] = [];
    return {
      renderer,
      imported: 0,
      items,
      player: {
        loadAnimation(config: Record<string, unknown>) {
          const item = { config, calls: [] as [string, ...unknown[]][] };
          items.push(item);
          const record =
            (name: string) =>
            (...args: unknown[]) =>
              void item.calls.push([name, ...args]);
          return {
            setSubframe: record("setSubframe"),
            goToAndPlay: record("goToAndPlay"),
            goToAndStop: record("goToAndStop"),
            destroy: record("destroy"),
          };
        },
      },
    };
  };
  return { svg: make("svg"), canvas: make("canvas") };
});

vi.mock("lottie-web/build/player/esm/lottie_light.min.js", () => {
  lottie.svg.imported++;
  return { default: lottie.svg.player };
});
vi.mock("lottie-web/build/player/esm/lottie_light_canvas.min.js", () => {
  lottie.canvas.imported++;
  return { default: lottie.canvas.player };
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = "";
  for (const k of ["svg", "canvas"] as const) lottie[k].items.length = 0;
});

const HOST = { v: "5.13.0", fr: 25, markers: [{ cm: "wave", tm: 0, dr: 24 }] };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the character", () => {
  it("loads no player until the session hands over the checked character", async () => {
    const { fake } = bound(viewOf("call"));
    fake.ui(uiState());
    await flush();
    expect(lottie.svg.imported + lottie.canvas.imported).toBe(0);
    // The session sets `character` only after the JSON passed its sha256 (6.2.9).
    fake.show(viewOf("call", { character: HOST }));
    await flush();
    expect(lottie.svg.imported).toBe(1);
    expect(lottie.canvas.imported).toBe(0);
  });

  it("plays lottie_light as 6.4.4 gives, in the tile's lower box", async () => {
    const { fake, $ } = bound(viewOf("call", { character: HOST }));
    fake.ui(uiState({ character: { anim: "wave" } }));
    await flush();
    const [item] = lottie.svg.items;
    expect(item!.config).toEqual({
      container: $(".character"),
      renderer: "svg",
      loop: true,
      autoplay: false,
      animationData: HOST,
      rendererSettings: { hideOnTransparent: true },
    });
    // A copy: lottie-web mutates what it plays.
    expect(item!.config.animationData).not.toBe(HOST);
    expect(item!.calls).toEqual([
      ["setSubframe", false],
      ["goToAndPlay", "wave", true],
    ]);
    fake.ui(uiState({ character: { anim: "wave" } }));
    fake.ui(uiState({ character: { anim: "nod" } }));
    expect(item!.calls.slice(2)).toEqual([["goToAndPlay", "nod", true]]);
    // A state without a character plays the idle marker.
    fake.ui({ phase: "framing" });
    expect(item!.calls.at(-1)).toEqual(["goToAndPlay", "idle", true]);
  });

  it("shows a static pose under reduced motion", async () => {
    const view = viewOf("call", { character: HOST });
    const { fake } = bound({
      ...view,
      a11y: { ...view.a11y, reduced_motion: true },
    });
    fake.ui(uiState({ character: { anim: "celebrate" } }));
    await flush();
    expect(lottie.svg.items[0]!.calls.at(-1)).toEqual([
      "goToAndStop",
      "celebrate",
      true,
    ]);
  });

  it("takes lottie_light_canvas for canvas, or auto at 2 GB or less", async () => {
    expect(rendererFor("svg")).toBe("svg");
    expect(rendererFor("canvas")).toBe("canvas");
    vi.stubGlobal("navigator", { deviceMemory: 4 });
    expect(rendererFor("auto")).toBe("svg");
    vi.stubGlobal("navigator", { deviceMemory: 2 });
    expect(rendererFor("auto")).toBe("canvas");
    vi.stubGlobal("navigator", {});
    expect(rendererFor("auto")).toBe("svg");
    vi.unstubAllGlobals();
    bound(viewOf("call", { character: HOST, lottieRenderer: "canvas" }));
    await flush();
    expect(lottie.canvas.imported).toBe(1);
    expect(lottie.canvas.items[0]!.config).toMatchObject({
      renderer: "canvas",
      loop: true,
      autoplay: false,
    });
  });

  it("shows colour alone without a character, and destroys it on unbind", async () => {
    const { el, fake, $ } = bound(viewOf("call", { character: HOST }));
    await flush();
    const [item] = lottie.svg.items;
    fake.show(viewOf("call", { character: null }));
    expect(item!.calls.at(-1)).toEqual(["destroy"]);
    expect($(".character").childNodes).toHaveLength(0);
    fake.show(viewOf("call", { character: HOST }));
    await flush();
    el.unbindSession(fake.bridge);
    expect(lottie.svg.items[1]!.calls.at(-1)).toEqual(["destroy"]);
  });
});
