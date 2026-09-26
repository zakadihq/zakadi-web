// The spec/06-web-sdk.md 6.1.5 share of detect, capture and probe: every export of
// the three modules, bundled with what they import, minified and gzipped as the
// session module imports them, stays under 4 KB. From the repository root:
// npx --no -- size-limit --config packages/web-core/test/detect/size-limit.config.js
const src = "../../src/";

export default [
  {
    name: "detect, capture and probe",
    import: {
      [`${src}detect/device.ts`]: "{ deviceFacts, inAppBrowser, matchQuirks }",
      [`${src}detect/profile.ts`]:
        "{ detect, fail, pickAudio, videoSourceKind }",
      [`${src}capture/camera.ts`]:
        "{ AUDIO_CONSTRAINTS, applyExposure, attachPreview, closeCamera, mediaErrorCode, openCamera }",
      [`${src}capture/meta.ts`]: "{ cameraMeta }",
      [`${src}capture/sources.ts`]:
        "{ audioSource, onFrames, pumpFrames, sendVideo }",
      [`${src}probe/observer.ts`]: "{ frameObserver }",
      [`${src}probe/probe.ts`]: "{ STEPS, cameraProbe }",
    },
    gzip: true,
    limit: "4 KB",
  },
];
