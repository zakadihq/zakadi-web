import { describe, expect, it } from "vitest";
import { builtin, PKG, REPO } from "./fakes";

// The manifest of spec/06-web-sdk.md 6.1.2 and the budgets of 6.1.5.
const fs = builtin<{ readFileSync(file: string, enc: "utf8"): string }>(
  "node:fs",
);
const here = PKG;
const repo = REPO;
const read = (file: string) => fs.readFileSync(file, "utf8");
const pkg = JSON.parse(read(here + "package.json")) as Record<string, unknown>;

describe("packages/ui/package.json (6.1.2, 11.4)", () => {
  it("has the 6.1.2 fields, version 0.0.0 and the Apache-2.0 licence", () => {
    expect(pkg).toMatchObject({
      name: "@zakadi/ui",
      version: "0.0.0",
      type: "module",
      license: "Apache-2.0",
      sideEffects: ["./dist/define.js"],
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./define": {
          types: "./dist/define.d.ts",
          default: "./dist/define.js",
        },
      },
      files: ["dist"],
      publishConfig: { access: "public", provenance: true },
      peerDependencies: { "@zakadi/web-core": "0.0.0" },
    });
    expect(pkg).not.toHaveProperty("main");
  });

  it("has lottie-web 5.13.x as its one dependency, MIT and locked at 5.13.0", () => {
    expect(pkg.dependencies).toEqual({ "lottie-web": "~5.13.0" });
    const lock = JSON.parse(read(repo + "package-lock.json")) as {
      packages: Record<string, { version?: string; license?: string }>;
    };
    expect(lock.packages["node_modules/lottie-web"]).toMatchObject({
      version: "5.13.0",
      license: "MIT",
    });
  });

  it("names no workspace: range in any manifest of the workspace", () => {
    for (const file of [
      repo + "package.json",
      repo + "packages/web-core/package.json",
      here + "package.json",
    ])
      expect(read(file)).not.toContain("workspace:");
  });
});

describe("npm run size (6.1.5)", () => {
  it("fails above 24 KB for @zakadi/ui without Lottie and 55 KB for each Lottie chunk", async () => {
    const { default: checks } =
      (await import("../../../size-limit.config.js")) as {
        default: {
          name: string;
          path: string | string[];
          entry?: string[];
          limit: string;
          gzip?: boolean;
        }[];
      };
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["@zakadi/ui without Lottie"]).toEqual({
      name: "@zakadi/ui without Lottie",
      path: ["packages/ui/dist/index.js", "packages/ui/dist/define.js"],
      entry: ["index", "define"],
      gzip: true,
      limit: "24 KB",
    });
    for (const [name, chunk] of [
      ["Lottie chunk", "lottie_light.min"],
      ["Lottie chunk (canvas)", "lottie_light_canvas.min"],
    ])
      expect(byName[name!]).toEqual({
        name,
        path: "packages/ui/dist/index.js",
        entry: [chunk],
        gzip: true,
        limit: "55 KB",
      });
  });
});
