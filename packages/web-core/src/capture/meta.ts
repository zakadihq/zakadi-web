// camera_meta (spec/01-protocol.md 1.4, spec/05-sdk-contract.md 5.9, spec/06-web-sdk.md
// 6.2.3): raw platform values, with every device and group id sent as a salted hash.
import type { CameraMetaMsg } from "@zakadi/protocol";

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );

/**
 * Builds camera_meta from the video track's raw capabilities and settings, the
 * encoder fields and probe entries given, and the video inputs of enumerateDevices().
 * Every device and group id, in the device list, the settings and the capabilities,
 * becomes the lowercase hex SHA-256 of `salt || utf8(id)`, where `salt` is the 16
 * bytes of the token's jti (a per-session salt, 5.9).
 */
export async function cameraMeta(
  video: MediaStreamTrack,
  probe: CameraMetaMsg["probe"],
  encoder: NonNullable<CameraMetaMsg["encoder"]>,
  salt: Uint8Array,
): Promise<CameraMetaMsg> {
  const hash = async (id: string) =>
    hex(
      await crypto.subtle.digest(
        "SHA-256",
        new Uint8Array([...salt, ...new TextEncoder().encode(id)]),
      ),
    );
  const hashIds = async (raw: object) => {
    const o: Record<string, unknown> = { ...raw };
    for (const k of ["deviceId", "groupId"]) {
      if (typeof o[k] === "string") o[k] = await hash(o[k]);
    }
    return o;
  };
  const devices = await navigator.mediaDevices
    .enumerateDevices()
    .catch(() => []);
  return {
    t: "camera_meta",
    source: "getUserMedia",
    devices: await Promise.all(
      devices
        .filter((d) => d.kind === "videoinput")
        .map(async (d) => ({
          kind: d.kind,
          label: d.label,
          device_id_hash: await hash(d.deviceId),
          group_id_hash: await hash(d.groupId),
        })),
    ),
    capabilities: await hashIds(video.getCapabilities?.() ?? {}),
    settings: await hashIds(video.getSettings()),
    encoder,
    probe,
  };
}
