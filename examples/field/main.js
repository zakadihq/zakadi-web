/* global window */
// The field call page (README.md, spec/09-data-and-mlops.md 9.11 item 4): one call from
// the tester's link. The fragment leaves the address bar before anything else; a link
// that cannot start a call says why and loads nothing more; otherwise `<zakadi-call>`
// runs the session. The page keeps nothing in storage or in the history state, and the
// token stays in memory until the SDK sends it in `hello` (spec/06-web-sdk.md 6.9).
import { configFrom, readLink } from "./link.js";

/**
 * Runs the page in `win`, a window; `load` resolves with createZakadiSession of
 * @zakadi/web-core and defineZakadiCall of @zakadi/ui. Resolves with the session, or
 * with null when none starts.
 */
export async function run(win, load) {
  const { document, history, location } = win;
  const hash = location.hash;
  history.replaceState(null, "", location.pathname + location.search);

  const why = (text) => {
    const box = document.getElementById("why");
    box.textContent = text;
    box.hidden = false;
    return null;
  };

  let config;
  try {
    config = configFrom(readLink(hash));
  } catch (e) {
    return why(
      `This link cannot start a call: ${e.message}. Ask the coordinator for a new link; each link runs one call.`,
    );
  }
  let sdk;
  try {
    sdk = await load();
  } catch {
    return why(
      "The call could not load. Open the link again on a steady connection, in Chrome 89 or later, or Safari 16.4 or later.",
    );
  }
  sdk.defineZakadiCall();
  let session;
  try {
    session = sdk.createZakadiSession(config);
  } catch (e) {
    // A TypeError of the SDK names what it refused, never the token.
    return why(
      `This link cannot start a call: ${e.message}. Ask the coordinator for a new link.`,
    );
  }
  // A token works once: a redial needs a new link.
  session.on("redial_requested", () => session.dispose());
  session.on("closed", () =>
    why(
      "The call has ended. A link runs one call: ask the coordinator for the next one.",
    ),
  );
  // `<zakadi-call>` shows how the call ended.
  session.start().catch(() => undefined);
  return session;
}

if (typeof window !== "undefined")
  run(window, () =>
    Promise.all([import("@zakadi/web-core"), import("@zakadi/ui")]).then(
      ([core, ui]) => ({
        createZakadiSession: core.createZakadiSession,
        defineZakadiCall: ui.defineZakadiCall,
      }),
    ),
  );
