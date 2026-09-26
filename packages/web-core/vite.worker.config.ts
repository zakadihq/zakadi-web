import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

// spec/06-web-sdk.md 6.1.3 and 6.1.4: src/engine/engine.worker.ts as ONE file,
// dist/engine.worker.js, with no import, export or import.meta. Everything it uses is
// bundled, @zakadi/protocol included, into an IIFE, which has no module syntax. This
// build runs first and empties dist/; vite.config.ts then adds the main entry.
export default defineConfig({
  tsconfig: "tsconfig.worker.json",
  define: {
    __LV_DEBUG__: "false",
    __LV_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // firefox84 = KaiOS 3.x
    target: ["es2020", "chrome94", "safari14", "ios14", "firefox84"],
    lib: {
      entry: "src/engine/engine.worker.ts",
      formats: ["iife"],
      name: "zakadiEngine",
      fileName: () => "engine.worker.js",
    },
    minify: "oxc",
    sourcemap: true,
    emptyOutDir: true,
  },
});
