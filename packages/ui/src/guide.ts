// The oval guide and the arc arrows over the self-view (spec/06-web-sdk.md 6.4.2,
// spec/05-sdk-contract.md 5.8, spec/01-protocol.md 1.5 `ui`), in the coordinates of the
// encoded frame. Rungs 0 to 2 of the 1.5 ladder are 480 x 640 and every rung is 3:4, so
// one viewBox holds at every rung. Pure arithmetic: nothing here touches the DOM.

/** The encoded frame: the SVG's viewBox is `0 0 W H`. */
export const W = 480;
export const H = 640;

const RX = 0.275 * W; // the width is 0.55 W
const RY = 1.3 * RX; // the height is 1.3 x the width (G3)
const TOP = 0.18 * H;

const f = (n: number) => Math.round(n * 10) / 10;

/** The oval: centred at 0.5 W, 0.55 W wide, its top at 0.18 H. */
export const OVAL = { cx: f(0.5 * W), cy: f(TOP + RY), rx: f(RX), ry: f(RY) };

/** The frame with the oval cut out (even-odd): the region `fill: dim` darkens. */
export const DIM =
  `M0 0H${W}V${H}H0Z` +
  `M${f(OVAL.cx - OVAL.rx)} ${OVAL.cy}` +
  `a${OVAL.rx} ${OVAL.ry} 0 1 0 ${f(2 * OVAL.rx)} 0` +
  `a${OVAL.rx} ${OVAL.ry} 0 1 0 ${f(-2 * OVAL.rx)} 0Z`;

export type Direction =
  "user_left" | "user_right" | "up" | "down" | "closer" | "further";

/** One arrow: its shaft, drawn along `progress` by its dash, and its head. */
export interface Arrow {
  d: string;
  length: number;
  head: string;
}

type Point = [number, number];

/** A point on the oval grown by `grow` units, at `deg` degrees (y down). */
const at = (deg: number, grow: number): Point => {
  const t = (deg * Math.PI) / 180;
  return [
    OVAL.cx + (OVAL.rx + grow) * Math.cos(t),
    OVAL.cy + (OVAL.ry + grow) * Math.sin(t),
  ];
};

function arrow(points: Point[]): Arrow {
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += Math.hypot(
      points[i]![0] - points[i - 1]![0],
      points[i]![1] - points[i - 1]![1],
    );
  const [x, y] = points[points.length - 1]!;
  const [px, py] = points[points.length - 2]!;
  const k = Math.hypot(x - px, y - py);
  const [ux, uy] = [(x - px) / k, (y - py) / k];
  return {
    d: "M" + points.map(([a, b]) => `${f(a)} ${f(b)}`).join("L"),
    length: f(length),
    head:
      `M${f(x - 18 * ux - 12 * uy)} ${f(y - 18 * uy + 12 * ux)}` +
      `L${f(x)} ${f(y)}` +
      `L${f(x - 18 * ux + 12 * uy)} ${f(y - 18 * uy - 12 * ux)}`,
  };
}

/** Along the grown oval from `a0` to `a1` degrees. */
const sweep = (a0: number, a1: number): Point[] =>
  Array.from({ length: 25 }, (_, i) => at(a0 + ((a1 - a0) * i) / 24, 30));

// Steep enough to stay inside the frame a tall self-view crops to (about the middle 60 %
// of its width on a phone).
const DIAGONALS = [-60, -120, 60, 120];

/**
 * The arrows of each `arc.direction`. The SVG is not mirrored: `user_left` sweeps over
 * the head to screen-left, which is the user's left in the mirrored preview, and
 * `user_right` to screen-right; `up` and `down` point as named; `closer` points outward
 * from the oval and `further` inward.
 */
export const ARROWS: Record<Direction, Arrow[]> = {
  user_left: [arrow(sweep(-50, -130))],
  user_right: [arrow(sweep(-130, -50))],
  up: [
    arrow([
      [OVAL.cx, TOP - 12],
      [OVAL.cx, TOP - 84],
    ]),
  ],
  down: [
    arrow([
      [OVAL.cx, TOP + 2 * RY + 12],
      [OVAL.cx, TOP + 2 * RY + 84],
    ]),
  ],
  closer: DIAGONALS.map((a) => arrow([at(a, 10), at(a, 50)])),
  further: DIAGONALS.map((a) => arrow([at(a, 50), at(a, 10)])),
};
