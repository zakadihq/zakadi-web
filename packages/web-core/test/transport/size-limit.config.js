// The transport and control budget of Z-043 (spec/06-web-sdk.md 6.1.5): the client,
// region ranking, framing, chain and loop, bundled from source with what they import
// (the @zakadi/protocol constants included), minified and gzipped. Paths are relative
// to this file. Run from the root:
// npx --no -- size-limit --config packages/web-core/test/transport/size-limit.config.js
export default [
  {
    name: "web-core transport and control",
    path: ["../../src/transport/client.ts", "../../src/transport/rank.ts"],
    gzip: true,
    limit: "5 KB",
  },
];
