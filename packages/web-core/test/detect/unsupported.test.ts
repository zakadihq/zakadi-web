import { Linter } from "eslint";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(
  new URL("../../static/unsupported.js", import.meta.url),
  "utf8",
);

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 9_3 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13E233 Safari/601.1";
const KAIOS_25 =
  "Mozilla/5.0 (Mobile; Nokia_8110_4G; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5";
const ANDROID_OPERA_MINI =
  "Opera/9.80 (Android; Opera Mini/36.2.2254/119.132; U; id) Presto/2.12.423 Version/12.16";

class FakeText {
  constructor(public nodeValue: string) {}
}

class FakeElement {
  readonly children: (FakeElement | FakeText)[] = [];
  readonly attributes: Record<string, string> = {};
  className = "";
  href = "";
  type = "";
  value = "";
  readOnly = false;
  selected = false;
  onclick: (() => void) | null = null;

  constructor(readonly tag: string) {}

  appendChild<T extends FakeElement | FakeText>(child: T): T {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  get firstChild() {
    return this.children[0];
  }

  select() {
    this.selected = true;
  }

  get text(): string {
    return this.children
      .map((c) => (c instanceof FakeElement ? c.text : c.nodeValue))
      .join("");
  }

  find(tag: string): FakeElement | undefined {
    for (const c of this.children) {
      if (!(c instanceof FakeElement)) continue;
      const found = c.tag === tag ? c : c.find(tag);
      if (found) return found;
    }
    return undefined;
  }
}

interface Page {
  lang?: string;
  language?: string;
  userAgent?: string;
  body?: boolean;
  host?: boolean;
  copies?: boolean;
}

// Runs unsupported.js in a fresh V8 context holding only a fake document, navigator
// and location.
function run(page: Page = {}) {
  const body = new FakeElement("body");
  const host = new FakeElement("zakadi-call");
  const listeners: Record<string, () => void> = {};
  const document = {
    documentElement: { lang: page.lang ?? "" },
    body: page.body === false ? null : body,
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeText(text),
    getElementsByTagName: (name: string) =>
      page.host && name === "zakadi-call" ? [host] : [],
    addEventListener: (type: string, fn: () => void) => {
      listeners[type] = fn;
    },
    execCommand: vi.fn(() => page.copies ?? true),
  };
  runInNewContext(SOURCE, {
    document,
    navigator: { userAgent: page.userAgent ?? IPHONE, language: page.language },
    location: {
      href: "https://rp.example/verify?step=2#top",
      host: "rp.example",
      pathname: "/verify",
      search: "?step=2",
    },
  });
  const box = () => (page.host ? host : body).find("div");
  return { document, body, listeners, box };
}

const e = String.fromCharCode(0xe9);
const EN = {
  message:
    "This browser can't run the video check. Open this link in Chrome (Android) or Safari (iPhone) to continue.",
  open: "Open in Chrome",
  copy: "Copy link",
  copied: "Link copied",
};
const FR = {
  message: `Ce navigateur ne peut pas effectuer la v${e}rification vid${e}o. Ouvrez ce lien dans Chrome (Android) ou Safari (iPhone) pour continuer.`,
  open: "Ouvrir dans Chrome",
  copy: "Copier le lien",
  copied: `Lien copi${e}`,
};

describe("static/unsupported.js", () => {
  it("parses as ES5 and names every global it reads in its global comment", () => {
    const messages = new Linter().verify(SOURCE, [
      {
        languageOptions: { ecmaVersion: 5, sourceType: "script" },
        rules: { "no-undef": "error" },
      },
    ]);
    expect(messages).toEqual([]);
  });

  it("shows the 6.3 message in English with a copy link", () => {
    const { box } = run();
    const shown = box()!;
    expect(shown.attributes.role).toBe("alert");
    expect(shown.className).toBe("zakadi-unsupported");
    expect(shown.find("p")!.text).toBe(EN.message);
    expect(shown.find("button")!.text).toBe(EN.copy);
    expect(shown.find("input")).toMatchObject({
      readOnly: true,
      value: "https://rp.example/verify?step=2#top",
    });
    expect(shown.find("a")).toBeUndefined();
  });

  it.each([
    ["the page language", { lang: "fr-CI", language: "en-GB" }],
    ["the browser language", { language: "fr" }],
  ])("shows the message in French for %s", (_, page) => {
    const shown = run({ ...page, userAgent: KAIOS_25 }).box()!;
    expect(shown.find("p")!.text).toBe(FR.message);
    expect(shown.find("button")!.text).toBe(FR.copy);
  });

  it("stays in English for another language", () => {
    const shown = run({ lang: "en-NG", language: "fr-FR" }).box()!;
    expect(shown.find("p")!.text).toBe(EN.message);
  });

  it.each([
    ["English", {}, EN.open],
    ["French", { lang: "fr" }, FR.open],
  ])(
    "offers Open in Chrome on Android through the intent URL (%s)",
    (_, page, label) => {
      const link = run({ ...page, userAgent: ANDROID_OPERA_MINI })
        .box()!
        .find("a")!;
      expect(link.text).toBe(label);
      expect(link.href).toBe(
        "intent://rp.example/verify?step=2#Intent;scheme=https;package=com.android.chrome;" +
          "S.browser_fallback_url=https%3A%2F%2Frp.example%2Fverify%3Fstep%3D2%23top;end",
      );
    },
  );

  it.each([
    ["English", {}, EN],
    ["French", { lang: "fr" }, FR],
  ])("copies the link with the copy command (%s)", (_, page, text) => {
    const { box, document } = run(page);
    const button = box()!.find("button")!;
    button.onclick!();
    expect(box()!.find("input")!.selected).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(button.text).toBe(text.copied);
  });

  it("leaves the link selected for a manual copy where the command fails", () => {
    const { box } = run({ copies: false });
    const button = box()!.find("button")!;
    button.onclick!();
    expect(box()!.find("input")!.selected).toBe(true);
    expect(button.text).toBe(EN.copy);
  });

  it("renders into the zakadi-call element when the page has one", () => {
    const { body, box } = run({ host: true });
    expect(box()!.find("p")!.text).toBe(EN.message);
    expect(body.children).toEqual([]);
  });

  it("waits for DOMContentLoaded when it runs before the body exists", () => {
    const { document, body, listeners } = run({ body: false });
    expect(body.children).toEqual([]);
    document.body = body;
    listeners.DOMContentLoaded!();
    expect(body.find("p")!.text).toBe(EN.message);
  });
});
