# Field call page

The page and the session tool of the phase 0 latency run (`spec/09-data-and-mlops.md`
9.11 item 4, D105): testers in Lagos, Accra, Nairobi and Johannesburg run real calls
from their phones, on their carriers, against the api and ingest hosts of eu-west-2,
eu-west-1 and af-south-1. The API key stays with the coordinator: `session.mjs` creates
each session and prints a link that carries only what the phone needs, and the page runs
the call with `<zakadi-call>`. Nothing here is a package: no dependency, no workspace.

## Build the directory to upload

From the repository root, with Node 24:

```sh
npm ci
npm run build
node examples/field/build.mjs
```

`build.mjs` writes `examples/field/dist/` afresh, or the empty directory given as its
argument: the page, the output of `@zakadi/web-core` and `@zakadi/ui`,
`@zakadi/protocol` and lottie-web's two players, all loaded through the page's import
map, with `LICENSE` and `NOTICE` of this repository and the licences of
`@zakadi/protocol` (Apache-2.0) and lottie-web (MIT). Every import resolves to a file in
the directory, so the engine worker and the capture worklet are same-origin.

Upload the directory to the static host of the run, served over HTTPS with `.js` files
as `text/javascript`. Put the packs of zakadi-content `v0.1.0` at
`<pack base><lang>/<version>/manifest.json`; when the pack base is on another origin
than the page, its host answers `Access-Control-Allow-Origin: *`. If the host sends a
`Content-Security-Policy` (`spec/06-web-sdk.md` 6.7), its `script-src` needs the hash
`build.mjs` prints for the inline import map.

## One link per call

The day's API key is never an argument, so it stays out of shell history and process
lists: put it in a file only the coordinator can read, or in `ZAKADI_API_KEY` from a
prompt that does not echo it (`read -rs ZAKADI_API_KEY && export ZAKADI_API_KEY`).

```sh
node examples/field/session.mjs --key-file ~/zakadi-key \
  --api https://api-<region>.<domain> \
  --page https://<static host>/ \
  --packs https://<static host>/packs/ \
  --locale en-NG --user-ref accra-03
```

It creates one `web` session at that api and prints three lines:

```text
session ses_01J8ZQ4XKD3M7V2N9B6T5R8W1H
expires 2026-10-05T09:05:00Z
https://<static host>/#eyJjbGllbnRfdG9rZW4iOi...
```

Send the link to the tester's phone. It runs one call and works until `expires`, five
minutes after it was made; a reload, a redial or a second call needs a new link. Keep
the session id with the city, carrier, phone and region of the call. `--user-ref` names
the tester by a pseudonym, never a name; the api keeps it hashed.

The tool exits 0 with a link, 1 when the api gives no session (a problem prints its
`code` and `request_id`, and no link), and 2 when an option is wrong. It refuses an
`http:` api base except on loopback, and never prints the key.

## What the tester sees

The page takes the session from the link's fragment and removes it from the address bar
before anything else, then shows the consent screen and runs the call. A link that
cannot start a call, such as one cut short when it was copied, says why and starts
nothing. The page stores nothing on the phone, where the SDK caches only the public pack
files, and needs Chrome 89 or later, or Safari 16.4 or later, for its import map.

## Tests

```sh
npm run build && npm run test:integration
```

The tests run the tool against a fake api on loopback, the page against a fake window
and SDK, and `build.mjs` into a temporary directory.
