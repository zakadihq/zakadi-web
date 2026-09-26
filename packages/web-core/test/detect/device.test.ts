import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deviceFacts,
  inAppBrowser,
  matchQuirks,
  type DeviceFacts,
  type DeviceQuirk,
} from "../../src/detect/device";

const UA = {
  chromeReduced:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  webView:
    "Mozilla/5.0 (Linux; Android 11; itel A571W Build/RP1A.201005.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  firefoxAndroid:
    "Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0",
  safari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1",
  firefoxIos:
    "Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/128.0 Mobile/15E148 Safari/605.1.15",
  kaios3: "Mozilla/5.0 (Mobile; rv:84.0) Gecko/84.0 Firefox/84.0 KAIOS/3.0",
  facebookAndroid:
    "Mozilla/5.0 (Linux; Android 13; TECNO KI5q Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/479.0.0.51.64;]",
  instagramAndroid:
    "Mozilla/5.0 (Linux; Android 12; Infinix X6816C Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 Instagram 346.0.0.40.108 Android (31/12; 320dpi; 720x1612; INFINIX; Infinix X6816C; Infinix-X6816C; mt6769; en_GB; 634108343)",
  facebookIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.4;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]",
  instagramIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 346.0.0.30.87 (iPhone14,5; iOS 17_4; en_US; en; scale=3.00; 1170x2532; 635063010)",
};

const GREASE = { brand: "Not;A=Brand", version: "24" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deviceFacts()", () => {
  it("takes os, model and browser from UA Client Hints where Chromium exposes them", async () => {
    const getHighEntropyValues = vi.fn(async () => ({
      platform: "Android",
      platformVersion: "13.0.0",
      model: "TECNO KI5q",
    }));
    vi.stubGlobal("navigator", {
      userAgent: UA.chromeReduced,
      userAgentData: {
        brands: [
          GREASE,
          { brand: "Chromium", version: "128" },
          { brand: "Google Chrome", version: "128" },
        ],
        mobile: true,
        platform: "Android",
        getHighEntropyValues,
      },
    });
    await expect(deviceFacts()).resolves.toEqual({
      sdk: { os: "Android 13", device: "TECNO KI5q", browser: "Chrome 128" },
      match: {
        platform: "web",
        browser: "Chrome",
        browser_major: 128,
        os_major: 13,
        model: "TECNO KI5q",
      },
    });
    expect(getHighEntropyValues).toHaveBeenCalledWith([
      "platformVersion",
      "model",
    ]);
  });

  it("names the Chromium browser from its brand and leaves an empty model out", async () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0",
      userAgentData: {
        brands: [
          { brand: "Microsoft Edge", version: "128" },
          GREASE,
          { brand: "Chromium", version: "128" },
        ],
        platform: "Windows",
        getHighEntropyValues: async () => ({
          platformVersion: "15.0.0",
          model: "",
        }),
      },
    });
    await expect(deviceFacts()).resolves.toMatchObject({
      sdk: { os: "Windows 15", browser: "Edge 128" },
      match: { browser: "Edge", os_major: 15, model: undefined },
    });
  });

  it("keeps no frozen version where Client Hints give only low-entropy values", async () => {
    vi.stubGlobal("navigator", {
      userAgent: UA.chromeReduced,
      userAgentData: {
        brands: [GREASE, { brand: "Google Chrome", version: "128" }],
        platform: "Android",
        getHighEntropyValues: async () => ({ platform: "Android" }),
      },
    });
    await expect(deviceFacts()).resolves.toEqual({
      sdk: { os: "Android", browser: "Chrome 128" },
      match: {
        platform: "web",
        browser: "Chrome",
        browser_major: 128,
        os_major: undefined,
        model: undefined,
      },
    });
  });

  it("falls back to the user agent string when getHighEntropyValues fails", async () => {
    vi.stubGlobal("navigator", {
      userAgent: UA.webView,
      userAgentData: {
        brands: [],
        platform: "",
        getHighEntropyValues: async () => {
          throw new Error("NotAllowedError");
        },
      },
    });
    await expect(deviceFacts()).resolves.toMatchObject({
      sdk: {
        os: "Android 11",
        device: "itel A571W",
        browser: "Android WebView 120",
      },
    });
  });

  it.each([
    [
      "Android WebView",
      UA.webView,
      {
        os: "Android 11",
        device: "itel A571W",
        browser: "Android WebView 120",
      },
    ],
    [
      "Samsung Internet",
      UA.samsung,
      {
        os: "Android 13",
        device: "SAMSUNG SM-A145F",
        browser: "Samsung Internet 23",
      },
    ],
    [
      "Firefox Android",
      UA.firefoxAndroid,
      { os: "Android 13", browser: "Firefox 120" },
    ],
    [
      "Safari iOS",
      UA.safari,
      { os: "iOS 17.4", device: "iPhone", browser: "Safari 17" },
    ],
    [
      "Chrome iOS",
      UA.chromeIos,
      { os: "iOS 17.4", device: "iPhone", browser: "Chrome 128" },
    ],
    [
      "Firefox iPadOS",
      UA.firefoxIos,
      { os: "iOS 16.7", device: "iPad", browser: "Firefox 128" },
    ],
    ["KaiOS 3", UA.kaios3, { os: "KaiOS 3.0", browser: "Firefox 84" }],
    [
      "reduced Chrome without Client Hints",
      UA.chromeReduced,
      { os: "Android", browser: "Chrome 128" },
    ],
    ["Facebook on iOS", UA.facebookIos, { os: "iOS 17.4", device: "iPhone" }],
  ])("reads the user agent string of %s", async (_, userAgent, sdk) => {
    vi.stubGlobal("navigator", { userAgent });
    const facts = await deviceFacts();
    expect(facts.sdk).toEqual(sdk);
  });
});

const facts = (match: DeviceFacts["match"]): DeviceFacts => ({
  sdk: {},
  match: { platform: "web", ...match },
});

describe("matchQuirks()", () => {
  // The two entries of the 02 2.6 example.
  const EXAMPLE: DeviceQuirk[] = [
    {
      match: { platform: "android", model_prefix: "TECNO KI5" },
      caps: { max_fps: 12, prefer_software_encoder: false },
    },
    {
      match: { platform: "web", browser: "Chrome", browser_major_max: 110 },
      caps: { profile: "mediarecorder" },
    },
  ];

  it("applies an entry only when every key of its match matches", () => {
    expect(
      matchQuirks(
        EXAMPLE,
        facts({ browser: "Chrome", browser_major: 105, model: "TECNO KI5q" }),
      ),
    ).toEqual({ profile: "mediarecorder" });
    expect(
      matchQuirks(EXAMPLE, facts({ browser: "Chrome", browser_major: 128 })),
    ).toEqual({});
    expect(
      matchQuirks(EXAMPLE, facts({ browser: "Firefox", browser_major: 105 })),
    ).toEqual({});
    expect(matchQuirks(EXAMPLE, facts({ browser: "Chrome" }))).toEqual({});
  });

  it("matches model_prefix against the model", () => {
    const quirks: DeviceQuirk[] = [
      {
        match: { platform: "web", model_prefix: "TECNO KI5" },
        caps: { max_fps: 12 },
      },
    ];
    expect(matchQuirks(quirks, facts({ model: "TECNO KI5q" }))).toEqual({
      max_fps: 12,
    });
    expect(matchQuirks(quirks, facts({ model: "TECNO KC8" }))).toEqual({});
    expect(matchQuirks(quirks, facts({}))).toEqual({});
  });

  it("checks the os and browser bounds inclusively and never matches an unknown value", () => {
    const quirks: DeviceQuirk[] = [
      {
        match: {
          browser: "Safari",
          os_major_min: 16,
          os_major_max: 17,
          browser_major_min: 16,
        },
        caps: { max_rung: 2 },
      },
    ];
    const safari = (os_major?: number, browser_major = 17) =>
      facts({ browser: "Safari", os_major, browser_major });
    expect(matchQuirks(quirks, safari(16))).toEqual({ max_rung: 2 });
    expect(matchQuirks(quirks, safari(17))).toEqual({ max_rung: 2 });
    expect(matchQuirks(quirks, safari(18))).toEqual({});
    expect(matchQuirks(quirks, safari(15))).toEqual({});
    expect(matchQuirks(quirks, safari(undefined))).toEqual({});
    expect(matchQuirks(quirks, safari(17, 15))).toEqual({});
  });

  it("never applies an entry with a key 2.6 does not list", () => {
    const quirks: DeviceQuirk[] = [
      { match: { platform: "web", ram_gb_max: 4 }, caps: { max_fps: 10 } },
    ];
    expect(matchQuirks(quirks, facts({ browser: "Chrome" }))).toEqual({});
  });

  it("applies matching entries in list order", () => {
    const quirks: DeviceQuirk[] = [
      { match: { platform: "web" }, caps: { max_fps: 15, max_rung: 1 } },
      { match: { browser: "Opera" }, caps: { max_fps: 5 } },
      {
        match: { browser: "Chrome" },
        caps: { max_fps: 20, prefer_software_encoder: true },
      },
    ];
    expect(matchQuirks(quirks, facts({ browser: "Chrome" }))).toEqual({
      max_fps: 20,
      max_rung: 1,
      prefer_software_encoder: true,
    });
  });

  it("matches the UA Client Hints model where the user agent string is reduced", async () => {
    vi.stubGlobal("navigator", {
      userAgent: UA.chromeReduced,
      userAgentData: {
        brands: [{ brand: "Google Chrome", version: "128" }],
        platform: "Android",
        getHighEntropyValues: async () => ({
          platformVersion: "13",
          model: "TECNO KI5q",
        }),
      },
    });
    const quirks: DeviceQuirk[] = [
      {
        match: { platform: "web", model_prefix: "TECNO KI5", os_major_min: 13 },
        caps: { max_fps: 12 },
      },
    ];
    expect(matchQuirks(quirks, await deviceFacts())).toEqual({ max_fps: 12 });
  });
});

describe("inAppBrowser()", () => {
  it.each([
    ["Facebook on Android", UA.facebookAndroid, "banner"],
    ["Instagram on Android", UA.instagramAndroid, "banner"],
    ["another Android WebView", UA.webView, "webview"],
    ["Facebook on iOS", UA.facebookIos, undefined],
    ["Instagram on iOS", UA.instagramIos, undefined],
    ["WhatsApp on Android (Chrome)", UA.chromeReduced, undefined],
    ["WhatsApp on iOS (Safari)", UA.safari, undefined],
    ["Samsung Internet", UA.samsung, undefined],
  ])("%s", (_, ua, expected) => {
    expect(inAppBrowser(ua)).toBe(expected);
  });

  it("reads navigator.userAgent by default", () => {
    vi.stubGlobal("navigator", { userAgent: UA.facebookAndroid });
    expect(inAppBrowser()).toBe("banner");
  });
});
