import {
  terminalStateForEnd,
  validateClientMsg,
  type EndMsg,
  type HelloMsg,
} from "@zakadi/protocol";
import type { Transcript } from "@zakadi/protocol/vectors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeError, screenFor } from "../../src/session/errors";
import { FakeSocket } from "../transport/fakes";
import { begin, sessions, setup, teardown, until } from "./harness";

// The fake-server replay of spec/05-sdk-contract.md 5.16 through the whole session: each
// sessions/*.jsonl of @zakadi/protocol@0.1.0 plays its server side against a session in
// the default UI mode, from its token, with the inline engine. The session's own
// messages come from the session: audio_state from the pack's playback, the user's
// cancel from the renderer's cancel control. It must end in the transcript's terminal
// state (5.8), and the token must appear only in hello (5.13).

/** The uplink each transcript implies: floor-breached's collapses to 64 kbps at 600 ms. */
const UPLINK: Record<string, [number, number][]> = {
  "floor-breached": [[600, 8000]],
};

/** The terminal state the transcript ends in: its `end`, else its close (6.10, 5.8). */
function expected(tr: Transcript) {
  const e = tr.meta.expect as { end?: EndMsg; close?: number } | undefined;
  if (e?.end) return terminalStateForEnd(e.end.reason);
  return screenFor(closeError(e?.close ?? 1006, "")[0]);
}

async function replay(tr: Transcript) {
  const hello = tr.lines.find((l) => "msg" in l && l.msg.t === "hello") as {
    msg: HelloMsg;
  };
  const token = hello.msg.token;
  const h = await setup({
    headless: false,
    config: {
      clientToken: token,
      ingest: [
        {
          region: "eu-west-2",
          url: `wss://ingest-euw2.zakadi.dev/v1/sessions/${tr.meta.session_id}/stream`,
        },
      ],
    },
  });
  const b = begin(h);
  await b.consented;
  await until(() => FakeSocket.all.length > 0);
  const sock = h.sock();
  sock.open();
  for (const [at, rate] of UPLINK[tr.meta.name] ?? [])
    setTimeout(() => (sock.uplink = rate), at);
  for (const l of tr.lines) {
    if ("close" in l)
      setTimeout(
        () => sock.serverClose(l.close.code, l.close.reason ?? ""),
        l.t_ms,
      );
    else if ("msg" in l && l.dir === "s2c")
      setTimeout(() => sock.receive(l.msg), l.t_ms);
    else if (
      "msg" in l &&
      l.msg.t === "ui_event" &&
      l.msg.event === "cancel_pressed"
    )
      setTimeout(() => h.renderer!.bridge!.press("cancel"), l.t_ms);
  }
  await vi.advanceTimersByTimeAsync(tr.lines.at(-1)!.t_ms + 1000);
  return { h, token, b };
}

afterEach(teardown);

describe.each(sessions)("replaying $meta.name through the session", (tr) => {
  it("ends in its terminal state, and the token appears only in hello", async () => {
    const { h, token, b } = await replay(tr);
    const screen = expected(tr);
    const view = h.renderer!.bridge!.view();
    expect(view.screen).toBe(screen);
    expect(["ended", "error"]).toContain(h.session.state);
    // start() settled: resolved if the call became active, else rejected.
    expect(b.result.ok).toBe(h.types().includes("active"));
    const e = tr.meta.expect as { end?: EndMsg; close?: number } | undefined;
    if (e?.end && h.session.state === "ended")
      expect(h.events).toContainEqual({
        type: "ended",
        outcome: e.end.outcome,
        reason: e.end.reason,
      });
    if (e?.close)
      expect(h.events).toContainEqual({
        type: "disconnected",
        close_code: e.close,
      });

    // The token: once, in hello, and nowhere else the SDK writes (6.9).
    const texts = h.sock().texts();
    expect(texts.filter((m) => JSON.stringify(m).includes(token))).toEqual([
      texts[0],
    ]);
    expect(texts[0]!.t).toBe("hello");
    for (const m of texts) expect(validateClientMsg(m)).toBe(true);
    const elsewhere = JSON.stringify([
      h.events,
      h.telemetry,
      h.calls,
      h.renderer!.views,
    ]);
    expect(elsewhere).not.toContain(token);
    expect(elsewhere).not.toContain(token.split(".")[1]);

    // closed follows, once, 30 s after the terminal state (5.11).
    expect(h.types()).not.toContain("closed");
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.types().filter((t) => t === "closed")).toHaveLength(1);
    expect(h.renderer!.bridge).toBeNull();
  });
});
