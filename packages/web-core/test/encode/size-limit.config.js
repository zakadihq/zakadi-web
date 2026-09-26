// The gzip budget of src/encode/ (spec/06-web-sdk.md 6.1.5): every export of the module
// bundled with what it imports, minified and gzipped. Paths are relative to this file.
// Run from the repository root:
//   npx --no -- size-limit --config packages/web-core/test/encode/size-limit.config.js
export default [
  {
    name: "src/encode with its imports",
    path: "../../src/encode/index.ts",
    gzip: true,
    limit: "6 KB",
  },
];
