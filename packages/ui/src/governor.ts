// The flash governor of spec/06-web-sdk.md 6.4.3 (WCAG 2.3.1, spec/05-sdk-contract.md
// 5.8): one per element, it passes at most three luminance-changing updates in any
// second; an update past that waits for the window to allow it, and the latest waiting
// update wins. The tile has none: its hue changes are isoluminant and server-rate-limited.

const WINDOW_MS = 1000;
const MAX = 3;

export interface Governor<T> {
  /** Shows `v` now, or as soon as the window allows. */
  set(v: T): void;
  /** Forgets the window and anything waiting; the next update applies at once. */
  reset(): void;
}

/** `key` names what a value looks like: an update to the value shown is no change. */
export function governor<T>(
  apply: (v: T) => void,
  key: (v: T) => string,
): Governor<T> {
  const times: number[] = [];
  let shown: string | undefined;
  let waiting: { v: T } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = (v: T) => {
    const now = performance.now();
    while (times.length && now - times[0]! >= WINDOW_MS) times.shift();
    if (times.length >= MAX) {
      waiting = { v };
      timer = setTimeout(flush, WINDOW_MS - (now - times[0]!));
      return;
    }
    times.push(now);
    shown = key(v);
    apply(v);
  };
  const flush = () => {
    timer = undefined;
    const w = waiting;
    waiting = undefined;
    if (w) run(w.v);
  };
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    waiting = undefined;
  };

  return {
    set(v) {
      if (key(v) === shown) return cancel();
      if (timer) waiting = { v };
      else run(v);
    },
    reset() {
      cancel();
      times.length = 0;
      shown = undefined;
    },
  };
}
