/* global AbortSignal, fetch, process, URL */
// The coordinator's session tool (README.md): creates one `web` session with POST
// /v1/sessions (spec/02-api.md 2.2) and prints its id, its expiry and the tester's link.
// The API key comes from --key-file or ZAKADI_API_KEY, never from an argument, and
// appears in no output, error or link; an http api base is refused off loopback, so the
// key never crosses a network in the clear (2.1). A problem response prints its `code`
// and `request_id` and no link (2.9). Node 24 built-ins only.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { LANG, LinkError, readLink, secureUrl, writeLink } from "./link.js";

const USAGE = `Usage: node examples/field/session.mjs --api <url> --page <url> --packs <url>
         --locale <tag> [--user-ref <ref>] [--key-file <file>]

Creates one web session and prints its id, its expiry and the tester's link.

  --api       the api base, such as https://api-euw2.example.net
  --page      the page's URL on the static host, such as https://field.example.net/
  --packs     the pack base: each pack is at <packs><lang>/<version>/manifest.json
  --locale    the session's language, such as en-NG
  --user-ref  the tester's pseudonym, which the api keeps hashed (default: field)
  --key-file  a file holding the API key; without it, ZAKADI_API_KEY holds it

The key is never an argument. https throughout; http only on loopback.
`;

// spec/02-api.md 2.1: zk_<env>_<32 random base62>.
const KEY_FORMAT = /^zk_[a-z0-9]{1,16}_[0-9A-Za-z]{32}$/;
const TIMEOUT_S = 30;

/** An error to print, and the exit status: 2 for a usage error, 1 for the rest. */
class Failure extends Error {
  constructor(message, status = 1) {
    super(message);
    this.status = status;
  }
}

let key = "";
// The one way out for text: the key never leaves, even inside a library's error.
const redact = (text) => (key ? text.split(key).join("[key]") : text);

/** The lines to print for `argv` and `env`: the session id, its expiry and the link. */
async function create(argv, env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        api: { type: "string" },
        page: { type: "string" },
        packs: { type: "string" },
        locale: { type: "string" },
        "user-ref": { type: "string", default: "field" },
        "key-file": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    // Never the argument itself: it could be the key.
    const what = {
      ERR_PARSE_ARGS_UNKNOWN_OPTION: "an unknown option",
      ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: "an argument that is not an option",
    }[e.code];
    throw new Failure(
      `${what ?? "an option without its value"}; see --help. The key is read from --key-file or ZAKADI_API_KEY only.`,
      2,
    );
  }
  if (values.help) return USAGE;
  if (!values.api || !values.page || !values.packs || !values.locale)
    throw new Failure(
      "give --api, --page, --packs and --locale; see --help",
      2,
    );

  const api = secureUrl(values.api);
  if (!api || api.pathname !== "/")
    throw new Failure(
      "--api must be an https origin, or http on loopback, with no path or credentials",
      2,
    );
  const page = secureUrl(values.page);
  if (!page)
    throw new Failure(
      "--page must be an https URL, or http on loopback, with no query or fragment",
      2,
    );
  const packs = secureUrl(values.packs);
  if (!packs)
    throw new Failure(
      "--packs must be an https URL, or http on loopback, with no query or fragment",
      2,
    );
  if (!packs.pathname.endsWith("/")) packs.pathname += "/";
  if (!LANG.test(values.locale))
    throw new Failure("--locale must be a language tag such as en-NG", 2);

  const source =
    values["key-file"] === undefined ? "ZAKADI_API_KEY" : "--key-file";
  let given = (env.ZAKADI_API_KEY ?? "").trim();
  if (source === "--key-file") {
    try {
      given = readFileSync(values["key-file"], "utf8").trim();
    } catch (e) {
      throw new Failure(`--key-file cannot be read (${e.code ?? "error"})`, 2);
    }
  }
  if (!given)
    throw new Failure("no API key: set ZAKADI_API_KEY or give --key-file", 2);
  if (!KEY_FORMAT.test(given))
    throw new Failure(
      `the key of ${source} is not an API key (zk_<env>_<32 letters and digits>)`,
      2,
    );
  key = given;

  let res;
  try {
    res = await fetch(new URL("/v1/sessions", api), {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        user_ref: values["user-ref"],
        locale: values.locale,
        channel: "web",
      }),
      // A redirect means a wrong api base; the key does not follow it.
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_S * 1000),
    });
  } catch (e) {
    const why =
      e.name === "TimeoutError"
        ? `no answer in ${TIMEOUT_S} s`
        : (e.cause?.code ?? e.cause?.message ?? e.message);
    throw new Failure(`${api.origin} did not answer: ${why}`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: the status and the request id say enough.
  }
  const id = body?.request_id ?? res.headers.get("zakadi-request-id") ?? "none";
  if (!res.ok) {
    const detail = typeof body?.detail === "string" ? `: ${body.detail}` : "";
    throw new Failure(
      `${res.status} ${body?.code ?? "error"} (request_id ${id})${detail}`,
    );
  }
  if (
    typeof body?.session_id !== "string" ||
    typeof body.expires_at !== "string"
  )
    throw new Failure(`${res.status} without a session (request_id ${id})`);
  const link = writeLink(page, body, api.origin, packs.href);
  try {
    // The page's own check, so that no link it would refuse is printed.
    readLink(new URL(link).hash);
  } catch (e) {
    if (!(e instanceof LinkError)) throw e;
    throw new Failure(
      `no link for this session (request_id ${id}): ${e.message}`,
    );
  }
  return `session ${body.session_id}\nexpires ${body.expires_at}\n${link}\n`;
}

try {
  process.stdout.write(
    redact(await create(process.argv.slice(2), process.env)),
  );
} catch (e) {
  process.stderr.write(
    redact(`session: ${e instanceof Failure ? e.message : String(e)}\n`),
  );
  process.exitCode = e instanceof Failure ? e.status : 1;
}
