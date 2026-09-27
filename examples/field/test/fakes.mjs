/* global Buffer, URL */
// The fakes of the field tests: an API key, a POST /v1/sessions response as
// api/openapi.yaml's SessionCreated describes it, a window for the page and the two
// functions the page takes from the SDK.

export const KEY = "zk_test_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
export const PAGE = "https://field.test/call/";
export const PACKS = "https://field.test/packs/";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const ID = "ses_01J8ZQ4XKD3M7V2N9B6T5R8W1H";
const pack = (lang) => ({
  lang,
  version: "0.1.0",
  url: `https://cdn.zakadi.dev/packs/${lang}/0.1.0/manifest.json`,
});

export const SESSION = {
  session_id: ID,
  client_token: [
    b64({ alg: "ES256", kid: "cp-2026-09", typ: "JWT" }),
    b64({
      aud: "ingest",
      sub: ID,
      jti: Buffer.alloc(16, 7).toString("base64url"),
      exp: 1790071500,
      lang: "fr-CI",
    }),
    "c2lnbmF0dXJl",
  ].join("."),
  expires_at: "2026-09-27T10:05:00Z",
  ingest: [
    {
      region: "eu-west-2",
      url: `wss://ingest-euw2.field.test/v1/sessions/${ID}/stream`,
    },
    {
      region: "af-south-1",
      url: `wss://ingest-afs1.field.test/v1/sessions/${ID}/stream`,
    },
  ],
  prompt_pack: pack("fr-CI"),
  ui: {
    consent_copy: {
      "fr-CI": {
        title: "V\u00e9rification vid\u00e9o",
        body: "Suivez deux consignes \u00e0 la cam\u00e9ra.",
        recording_notice: "Deux images sont gard\u00e9es 7 jours.",
      },
      "en-NG": {
        title: "A short video check",
        body: "Follow two short prompts on camera.",
        recording_notice: "Two still frames are kept for 7 days.",
      },
    },
    brand: { primary: "#0A5", logo_url: null },
    badge_text: null,
    packs: [pack("fr-CI"), pack("en-NG")],
  },
  policy_version: 1,
  status: "created",
};

/** A window at `href`: its location, history and document, and what the page did. */
export function fakeWindow(href) {
  const url = new URL(href);
  const log = [];
  const touched = [];
  const why = { textContent: "", hidden: true };
  const win = {
    location: {
      get hash() {
        return url.hash;
      },
      get pathname() {
        return url.pathname;
      },
      get search() {
        return url.search;
      },
    },
    history: {
      state: null,
      replaceState(state, title, to) {
        log.push(["replaceState", state, to]);
        this.state = state;
        url.href = new URL(to, url).href;
      },
    },
    document: {
      getElementById: (id) => (id === "why" ? why : null),
      get cookie() {
        touched.push("cookie");
        return "";
      },
      set cookie(value) {
        touched.push("cookie");
      },
    },
  };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches"])
    Object.defineProperty(win, name, {
      get() {
        touched.push(name);
        return undefined;
      },
    });
  return { win, url, log, touched, why };
}

/** createZakadiSession and defineZakadiCall, logging to `log`, and the session. */
export function fakeSdk(log) {
  const handlers = new Map();
  const session = {
    on(type, handler) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    start() {
      log.push(["start"]);
      return Promise.resolve();
    },
    dispose() {
      log.push(["dispose"]);
      handlers.get("closed")?.({});
    },
    emit: (type) => handlers.get(type)?.({}),
  };
  const sdk = {
    defineZakadiCall() {
      log.push(["defineZakadiCall"]);
    },
    createZakadiSession(config) {
      log.push(["createZakadiSession", config]);
      return session;
    },
  };
  return { sdk, session };
}
