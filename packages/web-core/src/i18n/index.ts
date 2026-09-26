// Localisation of the SDK's own chrome (spec/06-web-sdk.md 6.2.10,
// spec/05-sdk-contract.md 5.8 and 5.10).
import { en, fr, type SdkStrings } from "./strings.js";

export type { SdkStrings };

const TABLES = new Map([
  ["en", en],
  ["fr", fr],
]);

/**
 * The SDK strings for a BCP 47 locale, resolved from the full tag to its language
 * and then to English (`fr-CI` -> `fr` -> `en`). A non-empty `sessionUi.badge_text`
 * replaces the badge, which is never hidden (5.8).
 */
export function sdkStrings(
  locale: string,
  badgeText?: string | null,
): Readonly<SdkStrings> {
  const tag = locale.toLowerCase().replace("_", "-");
  const table = TABLES.get(tag) ?? TABLES.get(tag.split("-")[0] ?? "") ?? en;
  return badgeText?.trim() ? { ...table, badge: badgeText } : table;
}
