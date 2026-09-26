// The two claims the SDK reads from the client token without verifying it (spec/02-api.md
// 2.2, spec/06-web-sdk.md 6.2.6, 6.9): `sub`, the session id telemetry is filed under, and
// the 16 raw bytes of `jti`, which start the hash chain and salt the device ids.

const bytes = (b64url: string): Uint8Array =>
  Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );

/** Throws a TypeError for anything that is not a client token: API misuse (5.11). */
export function readToken(token: string): { sub: string; jti: Uint8Array } {
  try {
    const claims = JSON.parse(
      new TextDecoder().decode(bytes(token.split(".")[1]!)),
    ) as { sub?: unknown; jti?: unknown };
    const jti = bytes(String(claims.jti));
    if (typeof claims.sub === "string" && jti.length === 16)
      return { sub: claims.sub, jti };
  } catch {
    // Not base64url JSON.
  }
  throw new TypeError("clientToken is not a Zakadi client token");
}
