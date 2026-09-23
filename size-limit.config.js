// The gzip budgets of spec/06-web-sdk.md 6.1.5 at their hard limits: npm run size fails
// above them. Each check bundles its files with what they import (the @zakadi/protocol
// validators included), minifies and gzips, as a host application ships them.
export default [
  {
    name: "web-core main entry",
    path: "packages/web-core/dist/index.js",
    gzip: true,
    limit: "44 KB",
  },
  {
    // Every JavaScript file web-core ships: the main entry now, the engine worker
    // and the static files when they land.
    name: "core total without Lottie",
    path: "packages/web-core/dist/*.js",
    gzip: true,
    limit: "60 KB",
  },
];
