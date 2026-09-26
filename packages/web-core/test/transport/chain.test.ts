import { loadVectors } from "@zakadi/protocol/vectors";
import { describe, expect, it } from "vitest";
import { Chain } from "../../src/transport/chain";
import { fromBase64url, fromHex } from "./read";

// spec/01-protocol.md 1.4 `attest` against chain/*.json of the pinned protocol release,
// on the platform's crypto.subtle.
const cases = loadVectors().chain;

describe("chain vectors", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)(
    "$name reproduces h0, every chain_after and attest",
    async (c) => {
      const jti = fromBase64url(c.jti);
      expect(jti.byteLength).toBe(16);
      const chain = new Chain(c.session_id, jti);
      expect((await chain.attest()).chain).toBe(c.h0);
      for (const m of c.messages) {
        chain.feed(fromHex(m.hex).buffer as ArrayBuffer);
        expect((await chain.attest()).chain).toBe(m.chain_after);
      }
      expect(await chain.attest()).toEqual(c.attest);
    },
  );

  it("keeps send order when fed without waiting", async () => {
    const c = cases.find((x) => x.messages.length > 1)!;
    const chain = new Chain(c.session_id, fromBase64url(c.jti));
    for (const m of c.messages)
      chain.feed(fromHex(m.hex).buffer as ArrayBuffer);
    expect(await chain.attest()).toEqual(c.attest);
  });
});
