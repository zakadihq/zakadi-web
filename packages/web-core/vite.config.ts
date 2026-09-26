import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

// spec/06-web-sdk.md 6.1.3. The main entry, after vite.worker.config.ts has written
// dist/engine.worker.js, so dist/ is kept. The inline engine (src/engine/inline.ts) is
// a lazy chunk. worker-url.js stays an import: scripts/copy-static.mjs copies it
// verbatim, since bundling would rewrite the `new URL()` its host bundler must see.
export default defineConfig({
  define: {
    __LV_DEBUG__: "false",
    __LV_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // firefox84 = KaiOS 3.x
    target: ["es2020", "chrome94", "safari14", "ios14", "firefox84"],
    lib: { entry: { index: "src/index.ts" }, formats: ["es"] },
    minify: "oxc",
    sourcemap: true,
    emptyOutDir: false,
    rolldownOptions: {
      external: [/^@zakadi\/protocol/, /(^|\/)worker-url\.js$/],
      output: { chunkFileNames: "[name].js" },
    },
  },
});
