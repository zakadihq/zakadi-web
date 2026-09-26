# Changelog

All notable changes to `@zakadi/web-core` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The package: an ES module entry with its type declarations, and `@zakadi/protocol`
  0.1.0 as its one dependency.
- `createZakadiSession()`, `ZakadiError` and `LIVENESS_EVENT_TYPES`: the session API of
  the web SDK, with its events, the headless bridge and the renderer bridge that
  `<zakadi-call>` of `@zakadi/ui` binds to.
- The call: the SDK configuration with its kill switch, browser profile detection,
  consent carried over to a redial within 10 minutes, the camera and its constraint
  probe, region ranking, and the error mapping of every close code.
- The engine: WebCodecs and MediaRecorder encoding on the session media clock and the
  `zakadi.v1` transport with its hash chain, probe and control loop, in a dedicated
  worker or, where none starts, inline on the main thread.
- Prompt packs, hash checked and kept in Cache Storage, with each `say` played as one
  playback; telemetry to the host's sink and `POST /v1/telemetry`; accessibility
  settings; the SDK's own strings in English and French.
- The exports `./engine.worker.js`, `./capture.worklet.js` and `./unsupported.js`, for
  hosts that serve them from their own origin.
- `RendererView.palette`: the prompt pack's `tile_palette`, empty until the pack loads,
  with a view change when it arrives, for the tile's colour before the first `tile`.

[Unreleased]: https://github.com/zakadihq/zakadi-web/commits/main
