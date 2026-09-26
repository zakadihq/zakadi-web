import { afterEach, describe, expect, it, vi } from "vitest";
import { below, DEFAULTS, refusal, sdkConfig } from "../../src/session/config";
import { begin, setup, teardown, until } from "./harness";

// GET /v1/sdk/config (spec/05-sdk-contract.md 5.15, spec/02-api.md 2.6,
// spec/06-web-sdk.md 6.2.10): sdk_disabled on the kill switch, a version or a wrapper
// below its minimum; after 2 s without an answer, the last copy or the defaults, and
// `config_unavailable` telemetry.
afterEach(teardown);

describe("sdk_disabled (5.15, D25)", () => {
  it.each([
    [{ kill_switch: true, message: "Paused for maintenance." }, "kill_switch"],
    [{ min_version: "0.0.1" }, "min_version"],
    [
      { wrapper_min_version: { "@zakadi/react": "1.2.0" } },
      "wrapper_min_version",
    ],
  ])("%j refuses to start: %s", async (answer, cause) => {
    const h = await setup({
      headless: false,
      sdkConfig: { min_version: "0.0.0", kill_switch: false, ...answer },
      config: {
        ui: { mode: "default" },
        wrapper: { name: "@zakadi/react", version: "1.1.9" },
      },
    });
    const b = begin(h, false);
    await until(() => b.result.ok === false);
    expect(b.result.error).toMatchObject({
      code: "sdk_disabled",
      message: cause,
      recoverable: false,
    });
    const v = h.renderer!.bridge!.view();
    expect(v.screen).toBe("sdk_disabled");
    expect(v.message).toBe(
      "message" in answer ? (answer.message as string) : null,
    );
    // Refused before detection and consent.
    expect(h.types()).toEqual(["error"]);
    expect(h.media.getUserMedia).not.toHaveBeenCalled();
  });

  it("asks for platform web, this version and the wrapper", async () => {
    const h = await setup({
      config: { wrapper: { name: "@zakadi/angular", version: "1.0.3" } },
    });
    begin(h, false);
    await until(() => h.session.state === "consent");
    const url = new URL(h.calls[0]!);
    expect(url.pathname).toBe("/v1/sdk/config");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      platform: "web",
      version: "0.0.0",
      wrapper: "@zakadi/angular@1.0.3",
    });
  });
});

describe("without an answer in 2 s", () => {
  it("proceeds on the built-in defaults and reports config_unavailable", async () => {
    const h = await setup({ sdkConfig: null });
    begin(h, false);
    await vi.advanceTimersByTimeAsync(1990);
    expect(h.session.state).toBe("idle");
    await until(() => h.session.state === "consent");
    expect(h.telemetryNames()).toContain("config_unavailable");
    const at = h.telemetry.find((e) => e.name === "config_unavailable")!.t_ms;
    expect(at).toBeGreaterThanOrEqual(2000);
    expect(at).toBeLessThan(2100);
  });
});

describe("sdkConfig()", () => {
  it("keeps the answer 5 minutes, then asks again; after a failure the last copy stands", async () => {
    vi.useFakeTimers();
    let kill = true;
    let fail = false;
    const fetch = vi.fn(async () => {
      if (fail) throw new TypeError("offline");
      return Response.json({ kill_switch: kill, min_version: "0.0.0" });
    });
    vi.stubGlobal("fetch", fetch);
    const lost = vi.fn();
    const api = "https://api-memo.zakadi.test";
    expect((await sdkConfig(api, "1.0.0", undefined, lost)).kill_switch).toBe(
      true,
    );
    kill = false;
    await vi.advanceTimersByTimeAsync(299000);
    expect((await sdkConfig(api, "1.0.0", undefined, lost)).kill_switch).toBe(
      true,
    );
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    fail = true;
    // The kill switch holds offline: the last copy, and config_unavailable.
    expect((await sdkConfig(api, "1.0.0", undefined, lost)).kill_switch).toBe(
      true,
    );
    expect(lost).toHaveBeenCalledOnce();
    fail = false;
    expect((await sdkConfig(api, "1.0.0", undefined, lost)).kill_switch).toBe(
      false,
    );
    // Another version or wrapper never gets this copy: the defaults instead.
    fail = true;
    expect(await sdkConfig(api, "2.0.0", undefined, lost)).toEqual(DEFAULTS);
  });

  it("compares versions numerically and applies the wrapper's minimum only to it", () => {
    expect(below("0.9.9", "0.10.0")).toBe(true);
    expect(below("1.10.0", "1.9.0")).toBe(false);
    expect(below("1.2.0", "1.2.0")).toBe(false);
    expect(below("1.2.0-beta.1", "1.2.1")).toBe(true);
    const c = {
      ...DEFAULTS,
      wrapper_min_version: { "@zakadi/react": "2.0.0" },
    };
    expect(refusal(c, "1.0.0", undefined)).toBeNull();
    expect(
      refusal(c, "1.0.0", { name: "@zakadi/angular", version: "1.0.0" }),
    ).toBeNull();
    expect(
      refusal(c, "1.0.0", { name: "@zakadi/react", version: "1.9.9" }),
    ).toBe("wrapper_min_version");
  });
});
