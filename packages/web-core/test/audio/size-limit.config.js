// The gzip budget of the audio, telemetry, a11y and i18n modules: under 7 KB
// together, their share of the web-core main entry of spec 06 6.1.5, measured with
// what they import (@zakadi/protocol included), bundled and minified as a host
// application ships them. Run from the root:
// npx --no -- size-limit --config packages/web-core/test/audio/size-limit.config.js
// Paths are relative to this file.
export default [
  {
    name: "audio, telemetry, a11y and i18n",
    path: [
      "../../src/audio/index.ts",
      "../../src/telemetry/index.ts",
      "../../src/a11y/index.ts",
      "../../src/i18n/index.ts",
    ],
    gzip: true,
    limit: "7 KB",
  },
];
