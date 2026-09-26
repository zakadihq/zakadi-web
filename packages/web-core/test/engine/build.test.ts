import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtin } from "../transport/node";

// The build of spec/06-web-sdk.md 6.1.2 and 6.1.4, run here into temporary directories:
// vite.worker.config.ts writes the engine as one file, vite.config.ts the main entry with
// the inline engine as a lazy chunk, scripts/copy-static.mjs the verbatim files, and the
// package exports point at what they write.
const fs = builtin<{
  mkdtempSync(prefix: string): string;
  readdirSync(dir: string): string[];
  readFileSync(file: string): Uint8Array;
  readFileSync(file: string, enc: "utf8"): string;
  rmSync(dir: string, o: { recursive: boolean; force: boolean }): void;
}>("node:fs");
const os = builtin<{ tmpdir(): string }>("node:os");
const vm = builtin<{
  Script: new (code: string) => unknown;
  runInNewContext(code: string, context: object): unknown;
}>("node:vm");
const cp = builtin<{
  execFileSync(file: string, args: string[]): unknown;
}>("node:child_process");
const { execPath } = (
  globalThis as unknown as { process: { execPath: string } }
).process;

const root = new URL("../../", import.meta.url).pathname;
const pkg = JSON.parse(fs.readFileSync(root + "package.json", "utf8")) as {
  scripts: Record<string, string>;
  exports: unknown;
  sideEffects: unknown;
  files: unknown;
};
// Vite's own build API, typed here: its declarations need @types/node.
const vite = "vite";
type Build = (o: object) => Promise<unknown>;
const tmp = (name: string) =>
  fs.mkdtempSync(`${os.tmpdir()}/zakadi-web-core-${name}-`);
const dirs: Record<"worker" | "main" | "copy", string> = {
  worker: "",
  main: "",
  copy: "",
};
const read = (dir: string, file: string) =>
  fs.readFileSync(`${dir}/${file}`, "utf8");

beforeAll(async () => {
  dirs.worker = tmp("worker");
  dirs.main = tmp("main");
  dirs.copy = tmp("copy");
  const { build } = (await import(/* @vite-ignore */ vite)) as { build: Build };
  for (const [config, outDir] of [
    ["vite.worker.config.ts", dirs.worker],
    ["vite.config.ts", dirs.main],
  ] as const)
    await build({
      root,
      configFile: root + config,
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });
  cp.execFileSync(execPath, [root + "scripts/copy-static.mjs", dirs.copy]);
}, 60000);

afterAll(() => {
  for (const dir of Object.values(dirs))
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the engine worker build (6.1.4)", () => {
  it("writes dist/engine.worker.js as its one JavaScript file", () => {
    const js = fs.readdirSync(dirs.worker).filter((f) => f.endsWith(".js"));
    expect(js).toEqual(["engine.worker.js"]);
  });

  it("has no import, export or import.meta: it parses as a classic script", () => {
    const code = read(dirs.worker, "engine.worker.js");
    expect(() => new vm.Script(code)).not.toThrow();
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toContain("import.meta");
  });

  it("starts in a bare worker scope and posts engine-ready", () => {
    const posted: unknown[] = [];
    const self: { postMessage(m: unknown): void; onmessage: unknown } = {
      postMessage: (m) => posted.push(m),
      onmessage: null,
    };
    vm.runInNewContext(read(dirs.worker, "engine.worker.js"), {
      self,
      performance,
      WebSocket: class {},
    });
    expect(posted).toEqual([
      {
        k: "engine-ready",
        caps: { mstp: false, videoEncoder: false, audioEncoder: false },
      },
    ]);
    expect(typeof self.onmessage).toBe("function");
  });
});

describe("the main build (6.1.3, 6.1.4)", () => {
  it("loads the inline engine as a lazy chunk and keeps worker-url.js an import", () => {
    const index = read(dirs.main, "index.js");
    expect(index).toContain('import("./inline.js")');
    expect(index).not.toMatch(/from\s*"\.\/inline\.js"/);
    expect(index).toMatch(/from\s*"\.\/worker-url\.js"/);
    expect(fs.readdirSync(dirs.main)).toContain("inline.js");
    // The transport runs in the engine, never in the main entry.
    const eager = fs
      .readdirSync(dirs.main)
      .filter((f) => f.endsWith(".js") && f !== "inline.js")
      .map((f) => read(dirs.main, f))
      .join("\n");
    expect(eager).not.toContain("probe_done");
    expect(read(dirs.main, "inline.js")).toContain("probe_done");
  });
});

describe("the package (6.1.2)", () => {
  it("builds in the 6.1.2 order and copies the static files verbatim", () => {
    expect(pkg.scripts.build).toBe(
      "vite build -c vite.worker.config.ts && vite build && tsc6 --emitDeclarationOnly -p tsconfig.build.json && node scripts/copy-static.mjs",
    );
    for (const [file, from] of [
      ["worker-url.js", "src/worker-url.js"],
      ["capture.worklet.js", "static/capture.worklet.js"],
      ["unsupported.js", "static/unsupported.js"],
    ])
      expect(fs.readFileSync(`${dirs.copy}/${file}`)).toEqual(
        fs.readFileSync(root + from),
      );
  });

  it("exports the entry, the engine worker and the static files from dist", () => {
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./engine.worker.js": "./dist/engine.worker.js",
      "./capture.worklet.js": "./dist/capture.worklet.js",
      "./unsupported.js": "./dist/unsupported.js",
    });
    const written = [
      ...fs.readdirSync(dirs.worker),
      ...fs.readdirSync(dirs.main),
      ...fs.readdirSync(dirs.copy),
    ];
    for (const target of [
      "index.js",
      "engine.worker.js",
      "capture.worklet.js",
      "unsupported.js",
    ])
      expect(written).toContain(target);
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.files).toEqual(["dist"]);
  });

  it("keeps the worker pattern host bundlers detect in worker-url.js", () => {
    const code = read(dirs.copy, "worker-url.js");
    expect(code).toMatch(
      /new Worker\(new URL\("\.\/engine\.worker\.js", import\.meta\.url\), \{\s*type: "module",\s*name: "zakadi-engine",\s*\}\)/,
    );
    expect(code).toContain('new URL("./capture.worklet.js", import.meta.url)');
  });
});
