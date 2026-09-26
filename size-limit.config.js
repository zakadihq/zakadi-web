// The gzip budgets of spec/06-web-sdk.md 6.1.5 at their hard limits: npm run size fails
// above them. Each check bundles its files with what they import (the @zakadi/protocol
// validators included), minifies and gzips, as a host application ships them. `entry`
// keeps what a check's files load at once: the inline engine, a lazy chunk loaded only
// where no worker starts, is counted in neither the main entry nor the core total, and
// the Lottie players, lazy chunks of @zakadi/ui loaded only for a character, are counted
// on their own.
const dist = "packages/web-core/dist/";
const ui = "packages/ui/dist/";

export default [
  {
    name: "web-core main entry",
    path: dist + "index.js",
    entry: ["index"],
    gzip: true,
    limit: "44 KB",
  },
  {
    name: "engine.worker.js",
    path: dist + "engine.worker.js",
    gzip: true,
    limit: "16 KB",
  },
  {
    // Every JavaScript file web-core loads without the inline engine: the main entry,
    // the engine worker and the static files.
    name: "core total without Lottie",
    path: [
      dist + "index.js",
      dist + "engine.worker.js",
      dist + "capture.worklet.js",
      dist + "unsupported.js",
    ],
    entry: ["index", "engine.worker", "capture.worklet", "unsupported"],
    gzip: true,
    limit: "60 KB",
  },
  {
    // The element and its styles, both entries, without the lazy Lottie players.
    name: "@zakadi/ui without Lottie",
    path: [ui + "index.js", ui + "define.js"],
    entry: ["index", "define"],
    gzip: true,
    limit: "24 KB",
  },
  {
    // lottie_light, the SVG player, as the host's bundler splits it off.
    name: "Lottie chunk",
    path: ui + "index.js",
    entry: ["lottie_light.min"],
    gzip: true,
    limit: "55 KB",
  },
  {
    // lottie_light_canvas, loaded instead where the canvas renderer is chosen.
    name: "Lottie chunk (canvas)",
    path: ui + "index.js",
    entry: ["lottie_light_canvas.min"],
    gzip: true,
    limit: "55 KB",
  },
];
