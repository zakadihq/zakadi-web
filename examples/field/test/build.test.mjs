/* global process, URL */
// build.mjs into a new directory, after `npm run build` (spec/06-web-sdk.md 6.1.4, 6.7;
// spec/11-decision-log.md 11.4): every import of the page and of each script in the
// directory resolves, through the page's import map or a relative path, to a file
// inside it, and the licences come with the code.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ImportType, init, parse } from "es-module-lexer";

const ROOT = join(import.meta.dirname, "../../..");
let dir;
await init;

// The text around an import.meta that makes it new URL(<string>, import.meta.url), the
// way the engine worker and the capture worklet are found (6.1.4).
const URL_BEFORE =
  /\bnew\s+URL\s*\(\s*(?:"((?:[^"\\\r\n]|\\.)*)"|'((?:[^'\\\r\n]|\\.)*)')\s*,\s*$/;
const URL_AFTER = /^\s*\.\s*url\s*\)/;

/**
 * The module references of `source` as es-module-lexer reads it, past comments,
 * strings, templates and regular expressions: `{ kind, specifier }`, where `kind` is
 * `import` for a static import, a re-export or an import(), and `url` for a
 * new URL(<string>, import.meta.url). An import() of anything but a string throws,
 * since no file can be checked for it, as does source the parser cannot read.
 */
function references(source) {
  const [imports] = parse(source);
  return imports.flatMap(({ t, n, d, s, e }) => {
    if (t === ImportType.ImportMeta) {
      const url = URL_BEFORE.exec(source.slice(0, s));
      return url && URL_AFTER.test(source.slice(e))
        ? [{ kind: "url", specifier: url[1] ?? url[2] }]
        : [];
    }
    if (n === undefined)
      throw new SyntaxError(`an import() of an expression at offset ${d}`);
    return [{ kind: "import", specifier: n }];
  });
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "zakadi-field-build-"));
  execFileSync(
    process.execPath,
    [join(ROOT, "examples/field/build.mjs"), dir],
    {
      stdio: "pipe",
    },
  );
});
after(() => rmSync(dir, { recursive: true, force: true }));

const read = (...path) => readFileSync(join(...path), "utf8");

/** The directory's path of `url`, or null for a URL outside it or no file. */
function inside(url) {
  if (url?.protocol !== "file:") return null;
  const path = relative(dir, fileURLToPath(url));
  if (path.startsWith(`..${sep}`) || !existsSync(join(dir, path))) return null;
  return statSync(join(dir, path)).isFile() ? path.split(sep).join("/") : null;
}

test("every import in the directory resolves to a file inside it, through the import map or a relative path", () => {
  const html = read(dir, "index.html");
  const page = pathToFileURL(join(dir, "index.html"));
  const maps = [
    ...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g),
  ];
  assert.equal(maps.length, 1, "one import map");
  const { imports } = JSON.parse(maps[0][1]);

  // A bare specifier through the map (HTML, resolve a module specifier): its own key,
  // else the longest key ending in "/" that it starts with; any other one relative to
  // its module.
  const resolve = (specifier, base) => {
    if (/^(\/|\.\/|\.\.\/)/.test(specifier)) return new URL(specifier, base);
    if (URL.canParse(specifier)) return new URL(specifier);
    const key =
      specifier in imports
        ? specifier
        : Object.keys(imports)
            .filter((k) => k.endsWith("/") && specifier.startsWith(k))
            .sort((a, b) => b.length - a.length)[0];
    return key === undefined
      ? null
      : new URL(imports[key] + specifier.slice(key.length), page);
  };

  const unresolved = [];
  const reached = new Set();
  const check = (from, specifier, url) => {
    const path = inside(url);
    if (path) reached.add(path);
    else unresolved.push(`${from}: ${specifier}`);
  };
  for (const [, src] of html.matchAll(/(?:src|href)="([^"]*)"/g))
    check("index.html", src, new URL(src, page));
  const scripts = readdirSync(dir, { recursive: true }).filter((f) =>
    f.endsWith(".js"),
  );
  for (const file of scripts) {
    const module = pathToFileURL(join(dir, file));
    for (const { kind, specifier } of references(read(dir, file)))
      check(
        file,
        specifier,
        kind === "url"
          ? new URL(specifier, module)
          : resolve(specifier, module),
      );
  }
  for (const [key, address] of Object.entries(imports))
    if (!inside(new URL(address, page))) unresolved.push(`the map: ${key}`);
  assert.deepEqual(unresolved, []);
  // What the page loads, each through one form: the page's own scripts; static and
  // dynamic imports, relative and through the map; a re-export; new URL().
  assert.deepEqual(
    [
      "main.js",
      "vendor/web-core/unsupported.js",
      "link.js",
      "vendor/web-core/index.js",
      "vendor/ui/index.js",
      "vendor/web-core/inline.js",
      "vendor/protocol/index.js",
      "vendor/protocol/generated/server-validators.js",
      "vendor/lottie-web/lottie_light.min.js",
      "vendor/lottie-web/lottie_light_canvas.min.js",
      "vendor/web-core/engine.worker.js",
      "vendor/web-core/capture.worklet.js",
    ].filter((path) => !reached.has(path)),
    [],
  );
});

test("the directory carries zakadi-web's LICENSE and NOTICE and lottie-web's licence", () => {
  assert.equal(read(dir, "LICENSE"), read(ROOT, "LICENSE"));
  assert.equal(read(dir, "NOTICE"), read(ROOT, "NOTICE"));
  const lottie = join(ROOT, "node_modules/lottie-web");
  assert.equal(
    read(dir, "vendor/lottie-web/LICENSE.md"),
    read(lottie, "LICENSE.md"),
  );
  assert.equal(JSON.parse(read(lottie, "package.json")).license, "MIT");
  // @zakadi/protocol is Apache-2.0 with a NOTICE of its own, which goes with it.
  const protocol = join(ROOT, "node_modules/@zakadi/protocol");
  for (const file of ["LICENSE", "NOTICE"])
    assert.equal(read(dir, "vendor/protocol", file), read(protocol, file));
});

test("the scan reads every form of import and skips comments, strings, templates and regular expressions", () => {
  const source = [
    'import a, { b as c } from "./a.js";',
    'import "./side.js";',
    "import * as ns from './ns.js';",
    'export { d } from "./d.js";',
    'export * from "./e.js";',
    "export { a };",
    '// import x from "./comment.js";',
    '/* import("./block.js") */',
    "const s = \"import('./string.js')\";",
    "const t = `import(${'./x.js'.length}) ${`import('./nested.js')`}`;",
    'const r = /import("\\/regex.js")/.test(s) ? 1 / 2 : [import("./f.js")];',
    "if (r) /import('.\\/if.js')/.exec(t);",
    "const o = { import: 1, async import(x) { return x; } };",
    'new Worker(new URL("./worker.js", import.meta.url), { type: "module" });',
  ].join("\n");
  assert.deepEqual(references(source), [
    { kind: "import", specifier: "./a.js" },
    { kind: "import", specifier: "./side.js" },
    { kind: "import", specifier: "./ns.js" },
    { kind: "import", specifier: "./d.js" },
    { kind: "import", specifier: "./e.js" },
    { kind: "import", specifier: "./f.js" },
    { kind: "url", specifier: "./worker.js" },
  ]);
  assert.throws(
    () => references("import(name);"),
    /an import\(\) of an expression/,
  );
  assert.throws(() => references("const s = 'open;"), {
    message: "Parse error @:1:17",
  });
  assert.throws(() => references("f(() => {);"), {
    message: "Parse error @:1:1",
  });
});
