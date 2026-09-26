# Changelog

All notable changes to `@zakadi/ui` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The package: `defineZakadiCall()` and the `@zakadi/ui/define` entry register the
  `<zakadi-call>` custom element; importing `@zakadi/ui` registers nothing, and both
  entries import in Node. `lottie-web` 5.13 is its one dependency and
  `@zakadi/web-core` its peer.
- `<zakadi-call>`, the default call UI, drawn from the session's renderer bridge: the
  consent screen with its language switcher and accessibility options, the permission
  explainer, connecting, the call (the mirrored self-view with the oval and arc guide,
  the host tile and its nonce colour, digits, captions, controls and progress) and the
  terminal states with close and, where offered, redial. The badge shows on every
  screen.
- Theming through `--lv-color-primary`, `--lv-color-on-primary`, `--lv-color-text`,
  `--lv-caption-bg`, `--lv-font-family` and `--lv-radius`; caption colours under 4.5:1
  give way to the built-in pair. The events `zakadi-state`, `zakadi-redial` and
  `zakadi-close` bubble out of the element.
- The host's character, played by lottie-web's light players loaded on demand, with
  static poses under reduced motion.

[Unreleased]: https://github.com/zakadihq/zakadi-web/commits/main
