// The device facts of spec/06-web-sdk.md 6.2.6 (`hello.sdk`) and the device_quirks
// match of spec/02-api.md 2.6 and 06 6.2.3, from User-Agent Client Hints where
// Chromium exposes them, else from the user agent string; and the in-app browsers of 6.3.

/** The caps a device_quirks entry may set (02 2.6). */
export interface QuirkCaps {
  max_fps?: number;
  /** The best rung the loop may use: a higher index is a lower quality. */
  max_rung?: number;
  profile?: "mediarecorder";
  prefer_software_encoder?: boolean;
}

/** One entry of `device_quirks` in `GET /v1/sdk/config` (02 2.6). */
export interface DeviceQuirk {
  match: Record<string, unknown>;
  caps: QuirkCaps;
}

export interface DeviceFacts {
  /** `hello.sdk` os, device and browser (6.2.6), each present when known. */
  sdk: { os?: string; device?: string; browser?: string };
  /**
   * What device_quirks match keys compare with (02 2.6): `platform` ("web"), `browser`
   * (the name alone, as "Chrome"), `browser_major`, `os_major` and `model` (UA Client
   * Hints where exposed, else the user agent string).
   */
  match: Record<string, string | number | undefined>;
}

interface UAData {
  brands?: { brand: string; version: string }[];
  platform?: string;
  getHighEntropyValues?(
    hints: string[],
  ): Promise<{ platformVersion?: string; model?: string }>;
}

type Table = [name: string, pattern: RegExp][];

// First match wins, so the tokens of derived browsers come before Chrome's. Chromium
// browsers other than these name themselves through UA Client Hints.
const BROWSERS: Table = [
  ["Samsung Internet", /SamsungBrowser\/(\d+)/],
  ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
  ["Android WebView", /; wv\).*?Chrome\/(\d+)/],
  ["Chrome", /(?:CriOS|Chrome)\/(\d+)/],
  ["Safari", /Version\/(\d+).*Safari/],
];

const SYSTEMS: Table = [
  ["Android", /Android ([\d.]+)/],
  ["iOS", /(?:iPhone|iPad|iPod).*? OS ([\d_]+)/],
  ["KaiOS", /KAIOS\/([\d.]+)/i],
];

const scan = (table: Table, ua: string) => {
  for (const [name, pattern] of table) {
    const m = pattern.exec(ua);
    if (m) return [name, m[1]];
  }
  return [];
};

const major = (v?: string) => (v ? parseInt(v, 10) : undefined);

/** Reads the device facts, once per session. */
export async function deviceFacts(): Promise<DeviceFacts> {
  const ua = navigator.userAgent;
  const data = (navigator as Navigator & { userAgentData?: UAData })
    .userAgentData;
  let high: { platformVersion?: string; model?: string } = {};
  try {
    high =
      (await data?.getHighEntropyValues?.(["platformVersion", "model"])) ?? {};
  } catch {
    // The user agent string answers instead.
  }
  const brand = data?.brands?.find(
    (b) => !/Not.?A.?Brand|^Chromium$/.test(b.brand),
  );
  const [browser, version] = brand
    ? [brand.brand.replace(/^(Google|Microsoft) /, ""), brand.version]
    : scan(BROWSERS, ua);
  const [os, reported] =
    data?.platform && high.platformVersion
      ? [data.platform, high.platformVersion.replace(/(\.0)+$/, "")]
      : scan(SYSTEMS, ua).map((s) => s?.replace(/_/g, "."));
  // The reduced user agent string of Chrome says "Android 10; K" on every device.
  const osVersion =
    !high.platformVersion && /Android 10; K\)/.test(ua) ? undefined : reported;
  const fromUa =
    /Android[^;)]*; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(ua)?.[1] ??
    /iPhone|iPad|iPod/.exec(ua)?.[0];
  const model =
    high.model ||
    (fromUa && !/^(K|Mobile|Tablet)$/.test(fromUa) ? fromUa : undefined);
  const sdk: DeviceFacts["sdk"] = {};
  if (os) sdk.os = osVersion ? `${os} ${osVersion}` : os;
  if (model) sdk.device = model;
  if (browser) sdk.browser = version ? `${browser} ${version}` : browser;
  return {
    sdk,
    match: {
      platform: "web",
      browser,
      browser_major: major(version),
      os_major: major(osVersion),
      model,
    },
  };
}

/**
 * The caps of the device_quirks entries whose `match` keys all match (02 2.6; a key
 * not listed there never matches), applied in list order, so a later entry's cap
 * overrides an earlier one's.
 */
export function matchQuirks(
  quirks: readonly DeviceQuirk[],
  facts: DeviceFacts,
): QuirkCaps {
  const caps: QuirkCaps = {};
  for (const { match, caps: c } of quirks) {
    const applies = Object.entries(match).every(([key, v]) => {
      const [name = "", end] = key.split(/_(?=min$|max$)/);
      const x = facts.match[name === "model_prefix" ? "model" : name];
      if (end) {
        return (
          typeof x === "number" &&
          typeof v === "number" &&
          (end === "min" ? x >= v : x <= v)
        );
      }
      if (name === "model_prefix") {
        return (
          typeof x === "string" && typeof v === "string" && x.startsWith(v)
        );
      }
      return x !== undefined && x === v;
    });
    if (applies) Object.assign(caps, c);
  }
  return caps;
}

/**
 * The in-app browsers of 6.3 that change what the SDK does: `banner` for Facebook and
 * Instagram on Android (an "Open in Chrome" banner before consent, then the attempt),
 * `webview` for another Android WebView (the open-in-browser message on
 * NotAllowedError). Anything else, iOS in-app views and WhatsApp included, proceeds by
 * its detected engine: undefined.
 */
export function inAppBrowser(
  ua = navigator.userAgent,
): "banner" | "webview" | undefined {
  if (!/Android/.test(ua)) return undefined;
  if (/FBA[NV]\/|FB_IAB|Instagram/.test(ua)) return "banner";
  if (/; wv\)/.test(ua)) return "webview";
  return undefined;
}
