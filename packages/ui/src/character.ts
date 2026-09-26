// The host's character (spec/06-web-sdk.md 6.4.4, spec/05-sdk-contract.md 5.7): the
// pack's Lottie JSON, which the session hands over only after its SHA-256 check, played
// by lottie-web 5.13's `lottie_light` (SVG, no expressions, no eval) or
// `lottie_light_canvas`, each a chunk loaded by dynamic import when a character arrives.
// Without a character, or when the chunk fails to load, the tile shows its colour alone.
import type { AnimationItem, LottiePlayer } from "lottie-web";

export type LottieRenderer = "svg" | "canvas";

/** `canvas` when asked, or on `auto` where `navigator.deviceMemory` is 2 GB or less. */
export function rendererFor(choice: "auto" | LottieRenderer): LottieRenderer {
  if (choice !== "auto") return choice;
  const memory = (globalThis.navigator as { deviceMemory?: number } | undefined)
    ?.deviceMemory;
  return memory !== undefined && memory <= 2 ? "canvas" : "svg";
}

/** The player of each renderer, a lazy chunk. */
export const loadLottie = (renderer: LottieRenderer): Promise<LottiePlayer> =>
  (renderer === "canvas"
    ? import("lottie-web/build/player/esm/lottie_light_canvas.min.js")
    : import("lottie-web/build/player/esm/lottie_light.min.js")
  ).then((m) => m.default);

export interface Character {
  /** Plays the `character.anim` marker, or shows its first frame when `still`. */
  play(anim: string, still: boolean): void;
  destroy(): void;
}

/** Loads the character into `box` and plays what `play()` last asked for. */
export function character(
  box: HTMLElement,
  data: unknown,
  renderer: LottieRenderer,
): Character {
  let item: AnimationItem | undefined;
  let want: [string, boolean] | undefined;
  let shown = "";
  let gone = false;

  const apply = () => {
    if (!item || !want) return;
    const [anim, still] = want;
    if (shown === anim + still) return;
    shown = anim + still;
    try {
      // Non-numeric values are marker names, resolved through getMarkerData.
      if (still) item.goToAndStop(anim, true);
      else item.goToAndPlay(anim, true);
    } catch {
      // An animation without that marker keeps its frame.
    }
  };

  loadLottie(renderer).then(
    (lottie) => {
      if (gone) return;
      item = lottie.loadAnimation({
        container: box,
        renderer,
        loop: true,
        autoplay: false,
        // lottie-web mutates the data it plays; the session's copy stays whole.
        animationData: JSON.parse(JSON.stringify(data)) as unknown,
        ...(renderer === "svg"
          ? { rendererSettings: { hideOnTransparent: true } }
          : {}),
      });
      // The file's own frame rate, not the display's.
      item.setSubframe(false);
      apply();
    },
    () => undefined,
  );

  return {
    play(anim, still) {
      want = [anim, still];
      apply();
    },
    destroy() {
      gone = true;
      item?.destroy();
      item = undefined;
      box.textContent = "";
    },
  };
}
