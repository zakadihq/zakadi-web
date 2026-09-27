/* global Buffer, URL */
// The page (main.js) and its link (link.js) in Node, with a fake window and SDK: the
// fragment leaves the address bar before the session is created, nothing is stored,
// and a link that cannot start a call says why and loads nothing (spec/06-web-sdk.md
// 6.2.2, 6.9).
import assert from "node:assert/strict";
import { test } from "node:test";
import { secureUrl, writeLink } from "../link.js";
import { run } from "../main.js";
import { fakeSdk, fakeWindow, PACKS, PAGE, SESSION } from "./fakes.mjs";

const API = "https://api-euw2.field.test";
const LINK = writeLink(PAGE, SESSION, API, PACKS);
const STORES = ["localStorage", "sessionStorage", "indexedDB", "caches"];

/** A link whose fields are `fields`, as a tampered or truncated one would carry. */
const linkOf = (fields) =>
  `${PAGE}#${Buffer.from(JSON.stringify(fields)).toString("base64url")}`;
const fields = JSON.parse(
  Buffer.from(new URL(LINK).hash.slice(1), "base64url").toString(),
);

test("the page removes the fragment with history.replaceState before creating the session, and stores nothing", async () => {
  // Storage reached through the global object is caught as well as through the window.
  const touched = [];
  for (const name of STORES)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        touched.push(name);
        return undefined;
      },
    });
  try {
    const page = fakeWindow(LINK);
    const { sdk } = fakeSdk(page.log);
    const create = sdk.createZakadiSession;
    sdk.createZakadiSession = (config) => {
      page.log.push(["hash at createZakadiSession", page.win.location.hash]);
      return create(config);
    };
    const session = await run(page.win, async () => {
      page.log.push(["load"]);
      return sdk;
    });
    assert.ok(session);
    assert.deepEqual(
      page.log.map(([what]) => what),
      [
        "replaceState",
        "load",
        "defineZakadiCall",
        "hash at createZakadiSession",
        "createZakadiSession",
        "start",
      ],
    );
    // No state, and the URL of the page without its fragment.
    assert.deepEqual(page.log[0], ["replaceState", null, "/call/"]);
    assert.equal(page.log[3][1], "");
    assert.equal(page.url.href, PAGE);
    assert.equal(page.win.history.state, null);
    assert.deepEqual([...page.touched, ...touched], []);
    assert.equal(page.why.hidden, true);
  } finally {
    for (const name of STORES) delete globalThis[name];
  }
});

test("an unusable link shows why and starts nothing", async () => {
  const cases = [
    [PAGE, /it holds no session/],
    [LINK.slice(0, -40), /it is damaged/],
    [`${PAGE}#not*base64url`, /it is damaged/],
    [linkOf([1, 2]), /its content is not a session/],
    [linkOf({ ...fields, client_token: "" }), /its client token is missing/],
    [linkOf({ ...fields, ingest: [] }), /its ingest list is empty/],
    [
      linkOf({
        ...fields,
        prompt_pack: { lang: "fr-CI", version: "../0.1.0" },
      }),
      /its prompt pack has no language tag or version/,
    ],
    [
      linkOf({ ...fields, ui: { ...fields.ui, packs: [{ lang: "fr" }] } }),
      /its alternate packs lack a language tag or version/,
    ],
    [linkOf({ ...fields, ui: {} }), /its consent copy is missing/],
    [
      linkOf({ ...fields, api: "http://api-euw2.field.test" }),
      /its api base is not an https URL/,
    ],
    [
      linkOf({ ...fields, packs: "https://field.test/packs" }),
      /its pack base is not an https URL ending in \//,
    ],
  ];
  for (const [link, reason] of cases) {
    const page = fakeWindow(link);
    const session = await run(page.win, async () => {
      page.log.push(["load"]);
      return fakeSdk(page.log).sdk;
    });
    assert.equal(session, null, link);
    assert.deepEqual(page.log, [["replaceState", null, "/call/"]], link);
    assert.equal(page.why.hidden, false, link);
    assert.match(page.why.textContent, /^This link cannot start a call: /);
    assert.match(page.why.textContent, reason, link);
  }
});

test("a session the SDK refuses, or an SDK that does not load, shows why", async () => {
  const refused = fakeWindow(LINK);
  const { sdk } = fakeSdk(refused.log);
  sdk.createZakadiSession = () => {
    throw new TypeError("clientToken is not a Zakadi client token");
  };
  assert.equal(await run(refused.win, async () => sdk), null);
  assert.match(refused.why.textContent, /clientToken is not a Zakadi client/);
  assert.ok(!refused.log.some(([what]) => what === "start"));

  const offline = fakeWindow(LINK);
  const failed = await run(offline.win, () =>
    Promise.reject(
      new TypeError("Failed to fetch dynamically imported module"),
    ),
  );
  assert.equal(failed, null);
  assert.match(offline.why.textContent, /^The call could not load/);
});

test("a redial ends the session and asks for a new link", async () => {
  const page = fakeWindow(LINK);
  const { sdk, session } = fakeSdk(page.log);
  await run(page.win, async () => sdk);
  assert.equal(page.why.hidden, true);
  session.emit("redial_requested");
  assert.deepEqual(page.log.at(-1), ["dispose"]);
  assert.equal(page.why.hidden, false);
  assert.match(page.why.textContent, /^The call has ended/);
});

test("a base is https, or http on loopback, without credentials, query or fragment", () => {
  for (const ok of [
    "https://api-euw2.field.test",
    "https://field.test/packs/",
    "http://localhost:8080",
    "http://127.0.0.1:8080/",
    "http://[::1]:8080",
  ])
    assert.ok(secureUrl(ok), ok);
  for (const bad of [
    "http://api-euw2.field.test",
    "http://127.0.0.1.field.test",
    "http://localhost.field.test",
    "ws://127.0.0.1:8080",
    "https://user:secret@api-euw2.field.test",
    "https://field.test/?a=1",
    "https://field.test/#a",
    "api-euw2.field.test",
  ])
    assert.equal(secureUrl(bad), null, bad);
});
