// Node built-ins for the tests, typed here: the workspace has no @types/node.

/** A Node built-in, typed by the caller. */
export const builtin = <T>(id: string): T =>
  (
    globalThis as unknown as {
      process: { getBuiltinModule(id: string): T };
    }
  ).process.getBuiltinModule(id);

type Hash = { update(d: Uint8Array): Hash; digest(): Uint8Array };
const { createHash } = builtin<{ createHash(alg: string): Hash }>(
  "node:crypto",
);

/** SHA-256 on node:crypto, independent of the chain under test. */
export const sha256 = (...parts: Uint8Array[]): Uint8Array =>
  parts.reduce((h, p) => h.update(p), createHash("sha256")).digest();
