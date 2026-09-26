/* global process */
// The last step of `npm run build` (spec/06-web-sdk.md 6.1.2, 6.1.4): the files web-core
// ships as they are, copied verbatim beside dist/index.js and dist/engine.worker.js:
// worker-url.js, which the host's bundler reads, the capture worklet and the nomodule
// page script. An optional argument names another output directory.
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FILES = [
  "src/worker-url.js",
  "static/capture.worklet.js",
  "static/unsupported.js",
];

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = resolve(root, process.argv[2] ?? "dist");
mkdirSync(out, { recursive: true });
for (const file of FILES)
  copyFileSync(join(root, file), join(out, basename(file)));
