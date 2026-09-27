/* global console, process */
// Writes the static directory of the field call page (README.md) once `npm run build`
// has run: the page, the output of @zakadi/web-core and @zakadi/ui, @zakadi/protocol and
// lottie-web's two ES module players as installed, each under the page's import map, with
// the licences that come with them. Every import then resolves to a file inside the
// directory, so the engine worker and the capture worklet are same-origin
// (spec/06-web-sdk.md 6.1.4, 6.7). The directory is the argument, which must be absent
// or empty; without one, examples/field/dist is written afresh.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const here = import.meta.dirname;
const root = resolve(here, "../..");
const webCore = join(root, "packages/web-core");
const ui = join(root, "packages/ui");
const MARKER = "<!-- importmap: build.mjs puts the import map here -->";

/** The directory of the package `name` as Node finds it from `from`. */
function installed(from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const pkg = join(dir, "node_modules", name);
    if (existsSync(join(pkg, "package.json"))) return pkg;
    if (dirname(dir) === dir)
      throw new Error(`${name} is not installed: run npm ci`);
  }
}

/** The `.js` files of `dir`, with their source maps where `maps`. */
const scripts = (dir, maps) =>
  readdirSync(dir).filter(
    (f) => f.endsWith(".js") || (maps && f.endsWith(".js.map")),
  );

function build(out) {
  for (const dist of [webCore, ui])
    if (!existsSync(join(dist, "dist/index.js")))
      throw new Error(
        `${relative(root, dist)}/dist is missing: run npm run build`,
      );
  const protocol = installed(webCore, "@zakadi/protocol");
  const lottie = installed(ui, "lottie-web");
  const players = join(lottie, "build/player/esm");

  // [source, path in the directory]
  const files = [
    ...["main.js", "link.js", "page.css"].map((f) => [join(here, f), f]),
    [join(root, "LICENSE"), "LICENSE"],
    [join(root, "NOTICE"), "NOTICE"],
    ...scripts(join(webCore, "dist"), true).map((f) => [
      join(webCore, "dist", f),
      `vendor/web-core/${f}`,
    ]),
    ...scripts(join(ui, "dist"), true).map((f) => [
      join(ui, "dist", f),
      `vendor/ui/${f}`,
    ]),
    [join(protocol, "dist/index.js"), "vendor/protocol/index.js"],
    ...scripts(join(protocol, "dist/generated"), false).map((f) => [
      join(protocol, "dist/generated", f),
      `vendor/protocol/generated/${f}`,
    ]),
    [join(protocol, "LICENSE"), "vendor/protocol/LICENSE"],
    [join(protocol, "NOTICE"), "vendor/protocol/NOTICE"],
    ...["lottie_light.min.js", "lottie_light_canvas.min.js"].map((f) => [
      join(players, f),
      `vendor/lottie-web/${f}`,
    ]),
    [join(lottie, "LICENSE.md"), "vendor/lottie-web/LICENSE.md"],
  ];
  // What the page, the packages and their chunks import by name.
  const imports = {
    "@zakadi/web-core": "./vendor/web-core/index.js",
    "@zakadi/ui": "./vendor/ui/index.js",
    "@zakadi/protocol": "./vendor/protocol/index.js",
    "lottie-web/build/player/esm/lottie_light.min.js":
      "./vendor/lottie-web/lottie_light.min.js",
    "lottie-web/build/player/esm/lottie_light_canvas.min.js":
      "./vendor/lottie-web/lottie_light_canvas.min.js",
  };

  for (const [from, to] of files) {
    mkdirSync(dirname(join(out, to)), { recursive: true });
    copyFileSync(from, join(out, to));
  }
  const html = readFileSync(join(here, "index.html"), "utf8");
  if (!html.includes(MARKER))
    throw new Error("index.html has no import map marker");
  const map = `\n${JSON.stringify({ imports }, null, 2)}\n`;
  writeFileSync(
    join(out, "index.html"),
    html.replace(MARKER, `<script type="importmap">${map}</script>`),
  );
  // A Content-Security-Policy allows the inline import map by this hash (6.7).
  return `'sha256-${createHash("sha256").update(map).digest("base64")}'`;
}

try {
  const given = process.argv[2];
  const out = resolve(given ?? join(here, "dist"));
  if (!given) rmSync(out, { recursive: true, force: true });
  else if (existsSync(out) && readdirSync(out).length)
    throw new Error(`${out} is not empty`);
  mkdirSync(out, { recursive: true });
  const hash = build(out);
  console.log(`build: wrote ${relative(process.cwd(), out) || "."}`);
  console.log(`build: the import map's script-src hash is ${hash}`);
} catch (e) {
  console.error(`build: ${e.message}`);
  process.exitCode = 1;
}
