/* global Buffer, process, URL */
// session.mjs against a fake api on loopback (spec/02-api.md 2.1, 2.2, 2.9): the request
// it sends, what it prints, how it refuses, and the link read back by the page.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../main.js";
import { fakeSdk, fakeWindow, KEY, PACKS, PAGE, SESSION } from "./fakes.mjs";

const TOOL = join(import.meta.dirname, "../session.mjs");
const JSON_TYPE = { "content-type": "application/json" };

/** A fake api on 127.0.0.1 that answers every request with `answer()`. */
async function fakeApi(answer) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      const [status, headers, payload] = answer();
      res.writeHead(status, headers).end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => server.close(r)) };
}

const created = () => [
  201,
  { ...JSON_TYPE, "zakadi-request-id": "req_1" },
  JSON.stringify(SESSION),
];
const problem = (status, code) => () => [
  status,
  { "content-type": "application/problem+json", "zakadi-request-id": "req_9" },
  JSON.stringify({
    type: `https://docs.zakadi.dev/errors/${code}`,
    title: "Refused",
    status,
    detail: "The request was refused.",
    code,
    request_id: "req_9",
  }),
];

/** Runs session.mjs with `args` and only the environment `env`. */
function tool(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, ...args], {
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const args = (api, locale = "fr-CI") => [
  "--api",
  api,
  "--page",
  PAGE,
  "--packs",
  PACKS,
  "--locale",
  locale,
];
const linkOf = (stdout) => stdout.trimEnd().split("\n").at(-1);
/** Everything a run shows: its output, its errors and the text inside its link. */
const shown = ({ stdout, stderr }) => {
  const hash = /#([A-Za-z0-9_-]+)$/m.exec(stdout)?.[1] ?? "";
  return stdout + stderr + Buffer.from(hash, "base64url").toString();
};

test("against a fake api on loopback, the tool sends the key as Bearer, channel web and the chosen locale, and prints the session id, expiry and link", async () => {
  const api = await fakeApi(created);
  try {
    const out = await tool(args(api.url, "fr-CI"), { ZAKADI_API_KEY: KEY });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(api.requests.length, 1);
    const [req] = api.requests;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/sessions");
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(req.body), {
      user_ref: "field",
      locale: "fr-CI",
      channel: "web",
    });
    const lines = out.stdout.trimEnd().split("\n");
    assert.deepEqual(lines.slice(0, 2), [
      `session ${SESSION.session_id}`,
      `expires ${SESSION.expires_at}`,
    ]);
    assert.equal(lines.length, 3);
    assert.ok(lines[2].startsWith(`${PAGE}#`), lines[2]);
    assert.equal(out.stderr, "");
  } finally {
    await api.close();
  }
});

test("the link has no query, and the page's config from it holds the response's token, ingest and ui, apiBase the api base and the packs under the pack base", async () => {
  const api = await fakeApi(created);
  try {
    // A pack base without its last slash gains one.
    const given = args(api.url);
    given[given.indexOf(PACKS)] = PACKS.slice(0, -1);
    const out = await tool(given, { ZAKADI_API_KEY: KEY });
    assert.equal(out.code, 0, out.stderr);
    const link = new URL(linkOf(out.stdout));
    assert.equal(link.search, "");
    assert.equal(link.href.split("#")[0], PAGE);

    const page = fakeWindow(link.href);
    await run(page.win, async () => fakeSdk(page.log).sdk);
    const [, config] = page.log.find(
      ([what]) => what === "createZakadiSession",
    );
    const under = ({ lang, version }) => ({
      lang,
      version,
      url: `${PACKS}${lang}/${version}/manifest.json`,
    });
    assert.equal(config.clientToken, SESSION.client_token);
    assert.deepEqual(config.ingest, SESSION.ingest);
    assert.deepEqual(config.sessionUi, SESSION.ui);
    assert.equal(config.apiBase, api.url);
    assert.equal(config.locale, SESSION.prompt_pack.lang);
    assert.deepEqual(config.promptPack, under(SESSION.prompt_pack));
    assert.deepEqual(config.ui.alternatePacks, SESSION.ui.packs.map(under));
  } finally {
    await api.close();
  }
});

test("the key appears in no output, error or link, and no argument takes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zakadi-field-key-"));
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  const ok = await fakeApi(created);
  const refused = await fakeApi(problem(401, "unauthorized"));
  // A problem whose detail repeats the key, as no api should.
  const echo = await fakeApi(() => {
    const [status, headers, body] = problem(401, "unauthorized")();
    const detail = `The key ${KEY} is revoked.`;
    return [status, headers, JSON.stringify({ ...JSON.parse(body), detail })];
  });
  const down = await fakeApi(created);
  await down.close();
  try {
    const env = { ZAKADI_API_KEY: KEY };
    const runs = {
      "the key in the environment": [await tool(args(ok.url), env), 0],
      "the key in a file": [
        await tool([...args(ok.url), "--key-file", keyFile]),
        0,
      ],
      "a problem response": [await tool(args(refused.url), env), 1],
      "a problem that repeats the key": [await tool(args(echo.url), env), 1],
      "an api that does not answer": [await tool(args(down.url), env), 1],
      "an http api base off loopback": [
        await tool(args("http://api-euw2.field.test"), env),
        2,
      ],
    };
    // With no key in the environment, each of these is refused before any request.
    const before = ok.requests.length;
    for (const argv of [
      ["--key", KEY],
      [`--key=${KEY}`],
      ["-k", KEY],
      [KEY],
      ["--api-key", KEY],
    ])
      runs[argv.join(" ").replace(KEY, "<key>")] = [
        await tool([...args(ok.url), ...argv]),
        2,
      ];
    assert.equal(ok.requests.length, before);

    for (const [name, [out, code]] of Object.entries(runs)) {
      assert.equal(out.code, code, `${name}: ${out.stderr}`);
      assert.ok(!shown(out).includes(KEY), name);
    }
    assert.match(runs["the key in the environment"][0].stdout, /#/);
    assert.match(runs["the key in a file"][0].stdout, /#/);
    assert.equal(ok.requests.at(-1).headers.authorization, `Bearer ${KEY}`);
    assert.match(runs["--key <key>"][0].stderr, /an unknown option/);
    assert.match(runs["<key>"][0].stderr, /an argument that is not an option/);
    assert.match(
      runs["a problem that repeats the key"][0].stderr,
      /: The key \[key\] is revoked\.\n$/,
    );
  } finally {
    await ok.close();
    await refused.close();
    await echo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an http api base off loopback is refused", async () => {
  for (const api of [
    "http://api-euw2.field.test",
    "http://127.0.0.1.field.test:8080",
    "ws://127.0.0.1:8080",
  ]) {
    const out = await tool(args(api), { ZAKADI_API_KEY: KEY });
    assert.equal(out.code, 2, api);
    assert.match(
      out.stderr,
      /--api must be an https origin, or http on loopback/,
    );
    assert.equal(out.stdout, "");
  }
});

test("a wrong option exits 2 before any request, and --help prints the usage", async () => {
  const api = await fakeApi(created);
  try {
    const env = { ZAKADI_API_KEY: KEY };
    const cases = [
      [args(api.url).slice(0, -2), /give --api, --page, --packs and --locale/],
      [args(api.url, "en_NG"), /--locale must be a language tag/],
      [
        args(api.url).map((a) => (a === PAGE ? `${PAGE}?tester=1` : a)),
        /--page must be an https URL/,
      ],
      [
        args(api.url).map((a) =>
          a === PACKS ? "http://field.test/packs/" : a,
        ),
        /--packs must be an https URL/,
      ],
      [[...args(api.url), "--api"], /an option without its value/],
    ];
    for (const [argv, message] of cases) {
      const out = await tool(argv, env);
      assert.equal(out.code, 2, argv.join(" "));
      assert.match(out.stderr, message);
      assert.equal(out.stdout, "");
    }
    const noKey = await tool(args(api.url));
    assert.equal(noKey.code, 2);
    assert.match(
      noKey.stderr,
      /no API key: set ZAKADI_API_KEY or give --key-file/,
    );
    const notKey = await tool(args(api.url), {
      ZAKADI_API_KEY: "zk_test_short",
    });
    assert.equal(notKey.code, 2);
    assert.match(notKey.stderr, /the key of ZAKADI_API_KEY is not an API key/);
    assert.equal(api.requests.length, 0);

    const help = await tool(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage: node examples\/field\/session\.mjs/);
  } finally {
    await api.close();
  }
});

test("a problem response exits non-zero with its code and request_id and prints no link", async () => {
  for (const [status, code] of [
    [401, "unauthorized"],
    [400, "validation_error"],
    [429, "rate_limited"],
  ]) {
    const api = await fakeApi(problem(status, code));
    try {
      const out = await tool(args(api.url), { ZAKADI_API_KEY: KEY });
      assert.equal(out.code, 1);
      assert.equal(out.stdout, "");
      assert.equal(
        out.stderr,
        `session: ${status} ${code} (request_id req_9): The request was refused.\n`,
      );
    } finally {
      await api.close();
    }
  }
  // An answer that is no problem, such as a proxy's page, names the request id it has.
  const proxy = await fakeApi(() => [
    502,
    { "content-type": "text/html", "zakadi-request-id": "req_5" },
    "<html>Bad gateway</html>",
  ]);
  try {
    const out = await tool(args(proxy.url), { ZAKADI_API_KEY: KEY });
    assert.equal(out.code, 1);
    assert.equal(out.stdout, "");
    assert.equal(out.stderr, "session: 502 error (request_id req_5)\n");
  } finally {
    await proxy.close();
  }
});
