// Colour arithmetic for the call (spec/06-web-sdk.md 6.4.2, 6.4.3 and 6.2.10): the
// surround's grey from a relative luminance, the tile's hsl(), and the WCAG contrast
// ratio that decides whether caption tokens are accepted.

/** sRGB channels 0 to 255 and alpha 0 to 1. */
export type Rgba = [number, number, number, number];

/** The CSS colour of a palette entry: hue in degrees, saturation and lightness in %. */
export const hsl = ([h, s, l]: readonly number[]) => `hsl(${h}, ${s}%, ${l}%)`;

/**
 * The grey of relative luminance `y`: `round(255 v)` with `v` the standard sRGB encoding
 * of `y` (6.4.2, G5).
 */
export function grey(y: number): string {
  const x = Math.min(1, Math.max(0, y));
  const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  const c = Math.round(255 * v);
  return `rgb(${c}, ${c}, ${c})`;
}

const linear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** WCAG relative luminance. */
export const luminance = ([r, g, b]: readonly number[]) =>
  0.2126 * linear(r! / 255) +
  0.7152 * linear(g! / 255) +
  0.0722 * linear(b! / 255);

/** WCAG contrast ratio of a foreground over an opaque background. */
export function contrast(fg: Rgba, bg: Rgba): number {
  const over = (a: Rgba, b: Rgba): Rgba => [
    a[0] * a[3] + b[0] * (1 - a[3]),
    a[1] * a[3] + b[1] * (1 - a[3]),
    a[2] * a[3] + b[2] * (1 - a[3]),
    1,
  ];
  // A translucent background shows the white-most surround through it.
  const back = over(bg, [255, 255, 255, 1]);
  const [x, y] = [luminance(over(fg, back)), luminance(back)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** hsl() to sRGB, hue in degrees and saturation and lightness 0 to 1. */
function fromHsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const k = (n: number) => (n + h / 30) % 12;
  const c = (n: number) =>
    255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  return [c(0), c(8), c(4)];
}

const NAMED: Record<string, Rgba> = {
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
};

/**
 * Parses the colours a token is likely to hold (hex, rgb(), hsl(), black, white); null
 * for anything else, which the caller resolves through the browser or refuses.
 */
export function parseColor(value: string): Rgba | null {
  const s = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)?.[1];
  if (hex) {
    const full = hex.length < 5 ? [...hex].map((c) => c + c).join("") : hex;
    const n = (i: number) => parseInt(full.slice(2 * i, 2 * i + 2), 16);
    return [n(0), n(1), n(2), full.length > 6 ? n(3) / 255 : 1];
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (fn) {
    const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean);
    const num = (p: string | undefined, scale: number) =>
      p === undefined
        ? NaN
        : p.endsWith("%")
          ? (parseFloat(p) / 100) * scale
          : parseFloat(p);
    if (parts.length < 3 || parts.length > 4) return null;
    const alpha = parts[3] === undefined ? 1 : num(parts[3], 1);
    const rgb: number[] = fn[1]!.startsWith("rgb")
      ? parts.slice(0, 3).map((p) => num(p, 255))
      : fromHsl(
          parseFloat(parts[0]!),
          num(parts[1], 1) / (parts[1]!.endsWith("%") ? 1 : 100),
          num(parts[2], 1) / (parts[2]!.endsWith("%") ? 1 : 100),
        );
    const out = [...rgb, alpha];
    return out.every(Number.isFinite)
      ? (out.map((c, i) =>
          i < 3 ? Math.min(255, Math.max(0, c)) : Math.min(1, Math.max(0, c)),
        ) as Rgba)
      : null;
  }
  return NAMED[s] ?? null;
}
