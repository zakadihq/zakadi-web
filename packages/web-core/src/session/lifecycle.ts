// The lifecycle rows of spec/06-web-sdk.md 6.8 (spec/05-sdk-contract.md 5.14) that need
// listeners: backgrounding, the page going away, a muted camera or an interrupted
// AudioContext (an incoming call), a stopped AudioContext, ended tracks and headphones.
import type { UiEventMsg } from "@zakadi/protocol";
import type { Camera } from "../capture/camera";

export interface LifecycleHooks {
  event(e: UiEventMsg["event"], detail: Record<string, unknown>): void;
  /** Still away 2 s after leaving: hidden, a muted camera or interrupted audio. */
  interrupted(cause: string): void;
  /** Visible again: the wake lock is requested anew. */
  visible(): void;
  pagehide(): void;
  /** A capture track ended; `revoked` when the camera permission is now denied. */
  ended(revoked: boolean): void;
  /** The AudioContext stopped: resume it on the next tap. */
  suspended(): void;
}

const GRACE_MS = 2000;
// Headset-like device labels [heuristic].
const HEADSET =
  /head(set|phone)|ear(phone|bud)|airpods|bluetooth|hands-?free|\bbt\b/i;

async function denied(): Promise<boolean> {
  try {
    const p = await navigator.permissions.query({
      name: "camera" as PermissionName,
    });
    return p.state === "denied";
  } catch {
    // No permissions.query for the camera (Android WebView): not a revocation.
    return false;
  }
}

/** Watches the call; returns the detach. */
export function watch(
  camera: Camera,
  ctx: BaseAudioContext | null,
  hooks: LifecycleHooks,
): () => void {
  const offs: (() => void)[] = [];
  const on = (
    target: EventTarget | null | undefined,
    type: string,
    f: () => void,
  ) => {
    target?.addEventListener?.(type, f);
    offs.push(() => target?.removeEventListener?.(type, f));
  };
  const away = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let since = 0;
  const leave = (cause: string) => {
    if (away.has(cause)) return;
    if (!away.size) {
      hooks.event("app_backgrounded", { cause });
      since = Date.now();
      timer = setTimeout(() => hooks.interrupted(cause), GRACE_MS);
    }
    away.add(cause);
  };
  const back = (cause: string) => {
    if (!away.delete(cause) || away.size) return;
    clearTimeout(timer);
    // iOS may freeze the page before the timer fires: away for 2 s all the same.
    if (Date.now() - since >= GRACE_MS) hooks.interrupted(cause);
    else hooks.event("app_foregrounded", { cause });
  };

  on(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") leave("hidden");
    else {
      back("hidden");
      hooks.visible();
    }
  });
  on(globalThis, "pagehide", () => hooks.pagehide());
  on(camera.video, "mute", () => leave("camera"));
  on(camera.video, "unmute", () => back("camera"));
  for (const track of [camera.video, camera.audio])
    on(track, "ended", () => void denied().then(hooks.ended));
  on(ctx, "statechange", () => {
    const state: string = ctx!.state;
    if (state === "interrupted") return leave("audio");
    back("audio");
    if (state === "suspended") hooks.suspended();
  });

  let headset: boolean | undefined;
  const devices = async () => {
    const list = await navigator.mediaDevices
      .enumerateDevices()
      .catch(() => []);
    const now = list.some(
      (d) => d.kind !== "videoinput" && HEADSET.test(d.label),
    );
    if (headset !== undefined && now !== headset)
      hooks.event("headphones_changed", { connected: now });
    headset = now;
  };
  void devices();
  on(navigator.mediaDevices, "devicechange", () => void devices());
  if (document.visibilityState === "hidden") leave("hidden");

  return () => {
    clearTimeout(timer);
    offs.splice(0).forEach((off) => off());
  };
}
