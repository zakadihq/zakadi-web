// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtin } from "./fakes";

// Server-side rendering (spec/06-web-sdk.md 6.5): no module of @zakadi/ui touches
// window, document, navigator or customElements when imported, so both entries import
// in Node, from source and as built (6.1.2).
const fs = builtin<{
  mkdtempSync(prefix: string): string;
  readdirSync(dir: string): string[];
  readFileSync(file: string, enc: "utf8"): string;
  rmSync(dir: string, o: { recursive: boolean; force: boolean }): void;
}>("node:fs");
const os = builtin<{ tmpdir(): string }>("node:os");
const cp = builtin<{
  execFileSync(file: string, args: string[], o: object): string;
}>("node:child_process");
const { execPath } = (
  globalThis as unknown as { process: { execPath: string } }
).process;

const root = new URL("../", import.meta.url).pathname;
let out = "";

beforeAll(async () => {
  out = fs.mkdtempSync(`${os.tmpdir()}/zakadi-ui-`);
  // Vite's build API, typed here: its declarations need @types/node.
  const vite = "vite";
  const { build } = (await import(/* @vite-ignore */ vite)) as {
    build(o: object): Promise<unknown>;
  };
  await build({
    root,
    configFile: root + "vite.config.ts",
    logLevel: "silent",
    build: { outDir: out, emptyOutDir: true },
  });
}, 60000);

afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

describe("in Node", () => {
  it("imports both entries from source, and defineZakadiCall() does nothing", async () => {
    expect(typeof (globalThis as { HTMLElement?: unknown }).HTMLElement).toBe(
      "undefined",
    );
    const ui = await import("../src/index");
    await import("../src/define");
    expect(ui.defineZakadiCall()).toBeUndefined();
  });

  it("imports both built entries", () => {
    const code = `await import(${JSON.stringify(out + "/index.js")}); await import(${JSON.stringify(out + "/define.js")});`;
    expect(() =>
      cp.execFileSync(execPath, ["--input-type=module", "-e", code], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("keeps lottie-web an import of the host's, the two players lazy chunks", () => {
    const js = fs
      .readdirSync(out)
      .filter((f) => f.endsWith(".js"))
      .map((f) => fs.readFileSync(`${out}/${f}`, "utf8"))
      .join("\n");
    expect(js).toContain(
      'import("lottie-web/build/player/esm/lottie_light.min.js")',
    );
    expect(js).toContain(
      'import("lottie-web/build/player/esm/lottie_light_canvas.min.js")',
    );
    // No static import of it, and none of its code in the package's own files.
    expect(js).not.toMatch(/(^|\n)\s*import[^(]*["']lottie-web/);
    expect(js).not.toContain("bodymovin");
  });
});
