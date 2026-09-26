// Accessibility settings (spec/05-sdk-contract.md 5.10, spec/06-web-sdk.md 6.2.10).
import type { HelloMsg } from "@zakadi/protocol";

/** The `accessibility` option of the SDK configuration (6.2.2). */
export interface A11yConfig {
  screenReader?: boolean | undefined;
  captions?: boolean | undefined;
  reducedMotion?: boolean | undefined;
  extendedTime?: boolean | undefined;
}

/** The settings in force, shaped as `hello.a11y`. */
export type A11y = Required<NonNullable<HelloMsg["a11y"]>>;

/**
 * Resolves the settings: captions on unless configured off, reduced motion from the
 * `prefers-reduced-motion` media query unless configured. A page cannot detect a
 * screen reader, so screen-reader mode and extended time come from configuration or
 * the consent screen's accessibility options.
 */
export function a11ySettings(config: A11yConfig = {}): A11y {
  return {
    screen_reader: config.screenReader ?? false,
    captions: config.captions ?? true,
    reduced_motion: config.reducedMotion ?? prefersReducedMotion(),
    extended_time: config.extendedTime ?? false,
  };
}

function prefersReducedMotion(): boolean {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The haptic pulse of screen-reader mode on `frame.perfect` (5.10):
 * `navigator.vibrate(40)` where the browser supports it (Chrome for Android after a
 * user activation; Safari has none). Returns whether a pulse was requested.
 */
export function haptic(cue: string, settings: A11y): boolean {
  if (cue !== "frame.perfect" || !settings.screen_reader) return false;
  try {
    return navigator.vibrate?.(40) === true;
  } catch {
    return false;
  }
}
