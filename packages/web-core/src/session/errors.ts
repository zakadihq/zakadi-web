// SDK errors and their mapping (spec/06-web-sdk.md 6.10; spec/05-sdk-contract.md 5.8,
// 5.11; spec/01-protocol.md 1.11). Errors carry codes, never server text (6.9).
import type { EndMsg, ErrorCode, TerminalState } from "@zakadi/protocol";

export class ZakadiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly recoverable: boolean,
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "ZakadiError";
  }
}

// The codes 6.10 marks not recoverable; `internal` is not only in an insecure context.
const FINAL: ErrorCode[] = [
  "unsupported_device",
  "sdk_disabled",
  "auth_error",
  "protocol_error",
];

export const recoverable = (code: ErrorCode, cause: string): boolean =>
  !FINAL.includes(code) && cause !== "insecure_context";

/** The terminal state of an error (6.10, 5.8). */
export function screenFor(code: ErrorCode): TerminalState {
  switch (code) {
    case "unsupported_device":
    case "sdk_disabled":
    case "permission_denied":
    case "network_floor":
    case "interrupted":
    case "cancelled":
      return code;
    case "network_unavailable":
      return "disconnected";
    case "max_duration":
      return "incomplete";
    default:
      return "error";
  }
}

/**
 * The error of a close that no `end` preceded (6.10, 1.11), with `retry_after_s` from
 * the reason of 4008. Any other code, 1006 and 1000 included, is a lost transport.
 */
export function closeError(code: number, reason: string): [ErrorCode, number?] {
  const codes: Record<number, ErrorCode> = {
    4001: "auth_error",
    4002: "session_expired",
    4003: "session_expired",
    4004: "session_used",
    4005: "unsupported_device",
    4006: "protocol_error",
    4007: "network_floor",
    4008: "admission_rejected",
    4009: "max_duration",
    4010: "cancelled",
    4011: "internal",
  };
  const seconds = /\d+/.exec(reason);
  return code === 4008 && seconds
    ? ["admission_rejected", Number(seconds[0])]
    : [codes[code] ?? "network_unavailable"];
}

/** The rejection of start() when `end` arrives before `active`. */
export function endError(reason: EndMsg["reason"]): ErrorCode {
  const codes: Partial<Record<EndMsg["reason"], ErrorCode>> = {
    user_cancel: "cancelled",
    floor_breached: "network_floor",
    max_duration: "max_duration",
    admission: "admission_rejected",
  };
  return codes[reason] ?? "internal";
}
