import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

// spec/06-web-sdk.md 6.1.3. The engine worker build (vite.worker.config.ts) and the
// static files arrive with their sources.
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
    rolldownOptions: { external: [/^@zakadi\/protocol/, "./worker-url.js"] },
  },
});
