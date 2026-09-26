import type { ErrorCode, TerminalState } from "@zakadi/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serve, setup, teardown, toActive } from "./harness";

// Error mapping (spec/06-web-sdk.md 6.10, spec/05-sdk-contract.md 5.8 and 5.11,
// spec/01-protocol.md 1.11): closes without `end`, `end` with each reason, and the
// errors the client detects after open, each after `attest` and its `bye`.
afterEach(teardown);

type Row = [number, string, ErrorCode, boolean, TerminalState, number?];
// close code, the server's `error` before it, SDK error, recoverable, terminal state.
const CLOSES: Row[] = [
  [4001, "token", "auth_error", false, "error"],
  [4002, "token", "session_expired", true, "error"],
  [4003, "token", "session_expired", true, "error"],
  [4004, "token", "session_used", true, "error"],
  [4005, "unsupported_caps", "unsupported_device", false, "unsupported_device"],
  [4006, "protocol", "protocol_error", false, "error"],
  [4007, "", "network_floor", true, "network_floor"],
  [4008, "admission", "admission_rejected", true, "error", 7],
  [4009, "", "max_duration", true, "incomplete"],
  [4010, "", "cancelled", true, "cancelled"],
  [4011, "internal", "internal", true, "error"],
  [1006, "", "network_unavailable", true, "disconnected"],
  [1000, "", "network_unavailable", true, "disconnected"],
];

describe("a close without end (6.10, 1.11)", () => {
  it.each(CLOSES)(
    "%i maps to %s then %s, recoverable %s, state %s",
    async (code, serverError, sdk, recoverable, screen, retry) => {
      const h = await setup({ headless: false });
      await toActive(h);
      if (serverError)
        serve(h, {
          t: "error",
          code: serverError,
          detail: code === 4008 ? "retry_after=7" : "server text",
        });
      h.sock().serverClose(code, code === 4008 ? "retry_after=7" : "");
      await vi.advanceTimersByTimeAsync(10);
      const errors = h.events.filter((e) => e.type === "error");
      expect(errors).toEqual([
        {
          type: "error",
          code: sdk,
          message: `close ${code}`,
          recoverable,
          ...(retry ? { retry_after_s: retry } : {}),
        },
      ]);
      expect(h.events).toContainEqual({
        type: "disconnected",
        close_code: code,
      });
      expect(h.renderer!.bridge!.view().screen).toBe(screen);
      expect(h.session.state).toBe("error");
      // Codes only, never server text (6.9).
      expect(JSON.stringify(h.events)).not.toContain("server text");
    },
  );

  it("4008 whose close reason arrives empty: retry_after_s from the server's error", async () => {
    const h = await setup();
    await toActive(h);
    serve(h, { t: "error", code: "admission", detail: "retry_after=12" });
    h.sock().serverClose(4008, "");
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events.find((e) => e.type === "error")).toMatchObject({
      code: "admission_rejected",
      retry_after_s: 12,
    });
  });
});

describe("end, then the close (5.8, D46)", () => {
  it.each([
    ["completed", "ok", "completed"],
    ["aborted", "attempts_exhausted", "incomplete"],
    ["aborted", "max_duration", "incomplete"],
    ["aborted", "floor_breached", "network_floor"],
    ["aborted", "user_cancel", "cancelled"],
    ["aborted", "server_error", "error"],
    ["aborted", "admission", "error"],
  ])("%s %s ends in %s", async (outcome, reason, screen) => {
    const h = await setup({ headless: false });
    await toActive(h);
    serve(h, { t: "end", outcome, reason, retry: outcome === "aborted" });
    h.sock().serverClose(reason === "user_cancel" ? 4010 : 1000);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events.filter((e) => e.type === "ended")).toEqual([
      { type: "ended", outcome, reason },
    ]);
    expect(h.types()).not.toContain("error");
    expect(h.session.state).toBe("ended");
    expect(h.renderer!.bridge!.view().screen).toBe(screen);
    expect(h.telemetry).toContainEqual(
      expect.objectContaining({
        name: "end",
        fields: expect.objectContaining({ outcome, reason }),
      }),
    );
  });
});

describe("errors the client detects after open: attest and bye first (6.10)", () => {
  const byeThenError = async (
    h: Awaited<ReturnType<typeof setup>>,
    bye: string,
    code: ErrorCode,
    screen: TerminalState,
  ) => {
    await vi.advanceTimersByTimeAsync(10);
    const t = h.sock().texts();
    expect(t.slice(-2).map((m) => m.t)).toEqual(["attest", "bye"]);
    expect(t.at(-1)).toMatchObject({ t: "bye", reason: bye });
    expect(h.events.filter((e) => e.type === "error")).toEqual([
      expect.objectContaining({ code }),
    ]);
    expect(h.renderer!.bridge!.view().screen).toBe(screen);
    // The server then ends the call; nothing more is reported but the close.
    serve(h, {
      t: "end",
      outcome: "aborted",
      reason: "server_error",
      retry: true,
    });
    h.sock().serverClose(1000);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.types().filter((x) => x === "error" || x === "ended")).toEqual([
      "error",
    ]);
    expect(h.types().at(-1)).toBe("disconnected");
  };

  it("the camera's track ends with the permission revoked: bye permission_revoked", async () => {
    const h = await setup({ headless: false });
    await toActive(h);
    h.permission.state = "denied";
    h.video.fire("ended");
    await byeThenError(
      h,
      "permission_revoked",
      "permission_denied",
      "permission_denied",
    );
  });

  it("a track ends otherwise: bye capture_error", async () => {
    const h = await setup({ headless: false });
    await toActive(h);
    h.audio.fire("ended");
    await byeThenError(h, "capture_error", "capture_error", "error");
  });

  it("the encoder fails: bye encoder_error, from the engine", async () => {
    const h = await setup({ headless: false });
    await toActive(h);
    h.pipeline().fail("encoder_error");
    await byeThenError(h, "encoder_error", "encoder_error", "error");
  });
});
