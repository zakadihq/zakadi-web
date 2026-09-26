// GET /v1/sdk/config (spec/02-api.md 2.6, spec/05-sdk-contract.md 5.15, spec/06-web-sdk.md
// 6.2.10): at start(), within 2 s, the answer kept in memory for 5 minutes. Without an
// answer the SDK proceeds on the last copy or the built-in defaults and reports
// `config_unavailable`: the kill switch is best effort.
import type { DeviceQuirk } from "../detect/device";

export interface SdkConfig {
  min_version: string;
  kill_switch: boolean;
  wrapper_min_version: Record<string, string>;
  message: string | null;
  device_quirks: DeviceQuirk[];
}

type Wrapper = { name: string; version: string } | undefined;

export const DEFAULTS: SdkConfig = {
  min_version: "0.0.0",
  kill_switch: false,
  wrapper_min_version: {},
  message: null,
  device_quirks: [],
};
const TIMEOUT_MS = 2000;
const FRESH_MS = 300000;

let last: { url: string; at: number; config: SdkConfig } | undefined;

/** a < b as MAJOR.MINOR.PATCH; a pre-release suffix is ignored. */
export function below(a: string, b: string): boolean {
  const x = a.split(".").map((n) => parseInt(n, 10) || 0);
  const y = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/** Why the SDK refuses to start (5.15, D25), or null. */
export function refusal(
  c: SdkConfig,
  version: string,
  wrapper: Wrapper,
): "kill_switch" | "min_version" | "wrapper_min_version" | null {
  if (c.kill_switch) return "kill_switch";
  if (below(version, c.min_version)) return "min_version";
  const min = wrapper && c.wrapper_min_version[wrapper.name];
  return typeof min === "string" && below(wrapper!.version, min)
    ? "wrapper_min_version"
    : null;
}

function parse(json: unknown): SdkConfig {
  const o = (json ?? {}) as Partial<Record<keyof SdkConfig, unknown>>;
  const wrappers = o.wrapper_min_version;
  return {
    min_version:
      typeof o.min_version === "string" ? o.min_version : DEFAULTS.min_version,
    kill_switch: o.kill_switch === true,
    wrapper_min_version:
      wrappers && typeof wrappers === "object"
        ? (wrappers as Record<string, string>)
        : {},
    message: typeof o.message === "string" ? o.message : null,
    device_quirks: Array.isArray(o.device_quirks)
      ? (o.device_quirks as DeviceQuirk[])
      : [],
  };
}

/** The SDK config for this version and wrapper, fetched at most every 5 minutes. */
export async function sdkConfig(
  apiBase: string,
  version: string,
  wrapper: Wrapper,
  unavailable: () => void,
): Promise<SdkConfig> {
  const url = new URL("/v1/sdk/config", apiBase);
  url.searchParams.set("platform", "web");
  url.searchParams.set("version", version);
  if (wrapper)
    url.searchParams.set("wrapper", wrapper.name + "@" + wrapper.version);
  const key = url.href;
  const copy = last?.url === key ? last : undefined;
  if (copy && performance.now() - copy.at < FRESH_MS) return copy.config;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(key, { credentials: "omit", signal: ac.signal });
    if (!res.ok) throw new Error("status " + res.status);
    const config = parse(await res.json());
    last = { url: key, at: performance.now(), config };
    return config;
  } catch {
    unavailable();
    return copy?.config ?? DEFAULTS;
  } finally {
    clearTimeout(timer);
  }
}
