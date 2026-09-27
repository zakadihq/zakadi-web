/* global atob, btoa, TextDecoder, TextEncoder, URL */
// The tester's link (README.md): the page's URL with no query and a fragment, which no
// request carries. The fragment is the base64url JSON of the four fields POST
// /v1/sessions returns for the SDK, `client_token`, `ingest`, `prompt_pack` and `ui`,
// unchanged (spec/02-api.md 2.2, spec/05-sdk-contract.md 5.2), with `api`, the api base,
// and `packs`, the pack base. session.mjs writes it; the page reads it back into the
// config of createZakadiSession (spec/06-web-sdk.md 6.2.2). Node and browsers both load
// this module.

/** The fields of the POST /v1/sessions response the link carries. */
export const FIELDS = ["client_token", "ingest", "prompt_pack", "ui"];

/** Why a link cannot start a call: a clause the page and the tool put in a sentence. */
export class LinkError extends Error {}

/** A language tag as api/openapi.yaml's Locale, which keys the packs. */
export const LANG = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;
// A pack version is one path segment, so that a pack URL stays under the pack base.
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/**
 * `raw` as a URL if it is https, or http on loopback, and carries no credentials,
 * query or fragment; else null. An API key never crosses a network in the clear, and a
 * page served over http has no camera (spec/06-web-sdk.md 6.7).
 */
export function secureUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK.test(url.hostname));
  return secure && !url.username && !url.password && !url.search && !url.hash
    ? url
    : null;
}

/** `text` as unpadded base64url of its UTF-8 bytes. */
function encode(text) {
  let bytes = "";
  for (const b of new TextEncoder().encode(text))
    bytes += String.fromCharCode(b);
  return btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The UTF-8 text of base64url; throws on anything else. */
function decode(b64url) {
  const bytes = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(bytes, (c) => c.charCodeAt(0)),
  );
}

/** The link for `session`, a POST /v1/sessions response: `page` and its fragment. */
export function writeLink(page, session, api, packs) {
  const fields = {};
  for (const f of FIELDS) fields[f] = session[f];
  const url = new URL(page);
  url.hash = encode(JSON.stringify({ ...fields, api, packs }));
  return url.href;
}

const isObject = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isPack = (p) =>
  isObject(p) &&
  typeof p.lang === "string" &&
  LANG.test(p.lang) &&
  typeof p.version === "string" &&
  VERSION.test(p.version);

/**
 * The fields of the link whose fragment is `hash`, checked; throws a LinkError that
 * says why the link cannot start a call.
 */
export function readLink(hash) {
  const text = hash.replace(/^#/, "");
  if (!text) throw new LinkError("it holds no session");
  let link;
  try {
    link = JSON.parse(decode(text));
  } catch {
    throw new LinkError("it is damaged, perhaps cut short when it was copied");
  }
  const bad = (what) => {
    throw new LinkError(`its ${what}`);
  };
  if (!isObject(link)) bad("content is not a session");
  if (typeof link.client_token !== "string" || !link.client_token)
    bad("client token is missing");
  if (
    !Array.isArray(link.ingest) ||
    !link.ingest.length ||
    !link.ingest.every(
      (c) =>
        isObject(c) &&
        typeof c.region === "string" &&
        typeof c.url === "string",
    )
  )
    bad("ingest list is empty");
  if (!isPack(link.prompt_pack))
    bad("prompt pack has no language tag or version");
  if (!isObject(link.ui) || !isObject(link.ui.consent_copy))
    bad("consent copy is missing");
  if (
    link.ui.packs !== undefined &&
    !(Array.isArray(link.ui.packs) && link.ui.packs.every(isPack))
  )
    bad("alternate packs lack a language tag or version");
  if (typeof link.api !== "string" || !secureUrl(link.api))
    bad("api base is not an https URL");
  if (
    typeof link.packs !== "string" ||
    !secureUrl(link.packs) ||
    !link.packs.endsWith("/")
  )
    bad("pack base is not an https URL ending in /");
  return link;
}

/**
 * The config of createZakadiSession (spec/06-web-sdk.md 6.2.2) for the fields of a
 * checked link: the response's token, `ingest` and `ui` as they are, `apiBase` the api
 * base, and each pack, `lang` and `version` unchanged, at
 * `<pack base><lang>/<version>/manifest.json`. The alternate packs are the host
 * override `ui.alternatePacks`, so that `sessionUi` stays as the api sent it (5.2).
 */
export function configFrom(link) {
  const under = ({ lang, version }) => ({
    lang,
    version,
    url: `${link.packs}${lang}/${version}/manifest.json`,
  });
  return {
    clientToken: link.client_token,
    ingest: link.ingest,
    promptPack: under(link.prompt_pack),
    sessionUi: link.ui,
    locale: link.prompt_pack.lang,
    apiBase: link.api,
    ui: { alternatePacks: (link.ui.packs ?? []).map(under) },
  };
}
