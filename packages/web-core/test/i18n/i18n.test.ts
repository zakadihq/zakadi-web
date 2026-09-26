import { TERMINAL_STATES } from "@zakadi/protocol";
import { describe, expect, it } from "vitest";
import { sdkStrings } from "../../src/i18n/index.js";
import { en, fr } from "../../src/i18n/strings.js";

// spec/06-web-sdk.md 6.2.10 and 6.4.6, spec/05-sdk-contract.md 5.8.

// Every string of a table by its dotted path.
function flatten(table: object, prefix = ""): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(table).flatMap(([key, value]) =>
      value !== null && typeof value === "object"
        ? Object.entries(flatten(value as object, `${prefix}${key}.`))
        : [[`${prefix}${key}`, value]],
    ),
  );
}

describe("the SDK strings", () => {
  it("exist in en and fr, key for key, none empty", () => {
    const english = flatten(en);
    const french = flatten(fr);
    expect(Object.keys(french)).toEqual(Object.keys(english));
    for (const value of [...Object.values(english), ...Object.values(french)]) {
      expect(typeof value).toBe("string");
      expect((value as string).trim()).not.toBe("");
    }
  });

  it("are French in fr", () => {
    const english = flatten(en);
    const same = Object.entries(flatten(fr)).filter(
      ([key, value]) => english[key] === value,
    );
    expect(same).toEqual([]);
    expect(fr.consent.listen).toBe("\u00c9couter");
  });

  it("caption every terminal state", () => {
    const states = Object.keys(TERMINAL_STATES).sort();
    expect(Object.keys(en.end).sort()).toEqual(states);
    expect(Object.keys(fr.end).sort()).toEqual(states);
  });

  it("carry the 5.8 badge", () => {
    expect(en.badge).toBe("Automated check, no one is watching live");
  });
});

describe("sdkStrings()", () => {
  it.each([
    ["fr-CI", fr],
    ["fr", fr],
    ["fr-FR", fr],
    ["FR_ci", fr],
    ["en-NG", en],
    ["en", en],
    ["sw-KE", en],
    ["constructor", en],
    ["", en],
  ])("resolves %s through its language to en", (locale, table) => {
    expect(sdkStrings(locale)).toEqual(table);
  });

  it("puts sessionUi.badge_text in place of the badge", () => {
    const strings = sdkStrings(
      "fr-CI",
      "V\u00e9rification automatique de Acme",
    );
    expect(strings.badge).toBe("V\u00e9rification automatique de Acme");
    expect({ ...strings, badge: fr.badge }).toEqual(fr);
    expect(fr.badge).not.toBe(strings.badge);
  });

  it("keeps the default badge when badge_text is null or blank", () => {
    expect(sdkStrings("en-NG", null).badge).toBe(en.badge);
    expect(sdkStrings("en-NG", "").badge).toBe(en.badge);
    expect(sdkStrings("fr-CI", "   ").badge).toBe(fr.badge);
  });
});
