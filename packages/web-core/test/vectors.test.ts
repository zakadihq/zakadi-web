import { loadVectors } from "@zakadi/protocol/vectors";
import { describe, expect, it } from "vitest";

// The conformance vectors (spec/05-sdk-contract.md 5.16) of the pinned protocol release.
describe("loadVectors() from @zakadi/protocol/vectors", () => {
  const sets = Object.entries(loadVectors());

  it("returns the framing, chain, messages and sessions sets", () => {
    expect(sets.map(([name]) => name).sort()).toEqual([
      "chain",
      "framing",
      "messages",
      "sessions",
    ]);
  });

  it.each(sets)("finds cases in %s", (_name, cases) => {
    expect(cases.length).toBeGreaterThan(0);
  });
});
