# zakadi-web

Web SDK for Zakadi (active face liveness as a short automated video call). An npm workspaces monorepo with one `package-lock.json` at the root: `packages/web-core` (`@zakadi/web-core`: WebCodecs capture and encode, WebSocket transport, control loop), then `packages/ui` (`@zakadi/ui`, the `<zakadi-call>` Web Components call UI), `packages/react` and `packages/angular`, with `examples/` and `e2e/`. `@zakadi/protocol` comes from the npm registry at a pinned version; nothing of it is built here. Specification: `zakadi/spec/06-web-sdk.md` and the SDK contract `spec/05-sdk-contract.md`.

Status: `@zakadi/web-core` exposes the session API of `spec/06-web-sdk.md` 6.2.2 (`createZakadiSession`, `ZakadiError`, `LIVENESS_EVENT_TYPES`) over its engine worker, with the renderer bridge that `@zakadi/ui` draws from; `@zakadi/ui` provides the `<zakadi-call>` element and the local screens of `spec/06-web-sdk.md` 6.4 (`defineZakadiCall()` and the `@zakadi/ui/define` entry).

## Development

Node 24 and npm only: no pnpm, yarn or bun. From the root:

```sh
npm ci                          # the workspace and the lefthook git hooks
npm run format                  # prettier --check .
npm run lint                    # eslint . and the TypeScript 7 check of each package
npm test                        # Vitest in each package
npm run build && npm run size   # the library builds and the gzip budgets
```

Each package declares `typescript` 7 for its type check (`tsc`) and `@typescript/typescript6` for its declarations (`tsc6`). The root `typescript` is an npm alias of `@typescript/typescript6`, because typescript-eslint needs the TypeScript 6 API.

## Licence

Zakadi SDKs and client libraries are open source under the Apache License 2.0 (see `LICENSE`; the `NOTICE` file reserves the Zakadi trademarks). They are clients for the Zakadi service, which is proprietary; using it requires an account and acceptance of the Zakadi Terms of Service. Zakadi and the Zakadi logo are trademarks and are not covered by the Apache licence.
