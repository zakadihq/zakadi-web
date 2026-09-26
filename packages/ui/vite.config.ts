import { defineConfig } from "vitest/config";

// spec/06-web-sdk.md 6.1.3 and 6.4: the two entries, `index` and `define`, as ES modules
// for the web core's targets. lottie-web, the one dependency, stays an import that the
// host's bundler resolves: its two players are lazy chunks there (6.1.5). Vitest runs in
// happy-dom.
export default defineConfig({
  build: {
    // firefox84 = KaiOS 3.x
    target: ["es2020", "chrome94", "safari14", "ios14", "firefox84"],
    lib: {
      entry: { index: "src/index.ts", define: "src/define.ts" },
      formats: ["es"],
    },
    minify: "oxc",
    sourcemap: true,
    rolldownOptions: {
      external: [/^lottie-web(\/|$)/],
      output: { chunkFileNames: "[name].js" },
    },
  },
  test: { environment: "happy-dom" },
});
