# zakadi-web

Web SDK for Zakadi (active face liveness as a short automated video call). A pnpm monorepo: `packages/web-core` (WebCodecs capture and encode, WebSocket transport, control loop, Web Components call UI), `packages/react`, `packages/angular`, `packages/ui`, with `examples/` and `e2e/`. Specification: `zakadi/spec/06-web-sdk.md` and the SDK contract `spec/05-sdk-contract.md`. Depends on `@zakadi/protocol`.

Status: not yet started; the specification lives in the `zakadi` repository.

## Licence

Zakadi SDKs and client libraries are open source under the Apache License 2.0 (see `LICENSE`; the `NOTICE` file reserves the Zakadi trademarks). They are clients for the Zakadi service, which is proprietary; using it requires an account and acceptance of the Zakadi Terms of Service. Zakadi and the Zakadi logo are trademarks and are not covered by the Apache licence.
