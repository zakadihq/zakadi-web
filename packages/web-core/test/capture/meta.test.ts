import { validateCameraMetaMsg, type CameraMetaMsg } from "@zakadi/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cameraMeta } from "../../src/capture/meta";
import { deviceInfo, FakeTrack, installMedia } from "./fakes";

// The 16 raw bytes of a token's jti claim.
const SALT = Uint8Array.from({ length: 16 }, (_, i) => i);

// The hex SHA-256 of salt || utf8(id), computed apart from the module.
async function expected(id: string) {
  const bytes = new Uint8Array([...SALT, ...new TextEncoder().encode(id)]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CAPABILITIES = {
  deviceId: "cam-front-raw",
  groupId: "group-raw",
  facingMode: ["user"],
  width: { min: 1, max: 1280 },
  height: { min: 1, max: 720 },
  frameRate: { min: 1, max: 30 },
  exposureCompensation: { min: -2, max: 2, step: 0.1666 },
};
const SETTINGS = {
  deviceId: "cam-front-raw",
  groupId: "group-raw",
  facingMode: "user",
  width: 480,
  height: 640,
  frameRate: 30,
  resizeMode: "none",
};
const ENCODER = {
  impl: "hardware",
  is_config_supported: { "avc1.42E01F": true, vp8: true },
};
const PROBE: CameraMetaMsg["probe"] = [
  {
    request: { height: 3001 },
    reported: { w: 720, h: 1280, fps: 30 },
    observed: { w: 720, h: 1280, fps: 29.6 },
    reconfig_ms: 143,
    method: "mstp",
  },
  { request: { fps: 30 }, skipped: true },
];

function setup() {
  const track = new FakeTrack({
    settings: SETTINGS,
    capabilities: CAPABILITIES,
  });
  installMedia({
    enumerateDevices: async () => [
      deviceInfo(
        "videoinput",
        "cam-front-raw",
        "group-raw",
        "camera2 1, facing front",
      ),
      deviceInfo("audioinput", "mic-raw", "group-raw", "Microphone"),
      deviceInfo(
        "videoinput",
        "cam-back-raw",
        "group-back-raw",
        "camera2 0, facing back",
      ),
    ],
  });
  return track as unknown as MediaStreamTrack;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cameraMeta()", () => {
  it("carries raw capabilities and settings, the encoder and probe given, and salted ids", async () => {
    const meta = await cameraMeta(setup(), PROBE, ENCODER, SALT);
    const front = await expected("cam-front-raw");
    const group = await expected("group-raw");
    expect(meta).toEqual({
      t: "camera_meta",
      source: "getUserMedia",
      devices: [
        {
          kind: "videoinput",
          label: "camera2 1, facing front",
          device_id_hash: front,
          group_id_hash: group,
        },
        {
          kind: "videoinput",
          label: "camera2 0, facing back",
          device_id_hash: await expected("cam-back-raw"),
          group_id_hash: await expected("group-back-raw"),
        },
      ],
      capabilities: { ...CAPABILITIES, deviceId: front, groupId: group },
      settings: { ...SETTINGS, deviceId: front, groupId: group },
      encoder: ENCODER,
      probe: PROBE,
    });
    expect(front).toMatch(/^[0-9a-f]{64}$/);
  });

  it("passes validateCameraMetaMsg and sends no raw id", async () => {
    const meta = await cameraMeta(setup(), PROBE, ENCODER, SALT);
    const wire = JSON.parse(JSON.stringify(meta));
    expect(
      validateCameraMetaMsg(wire),
      JSON.stringify(validateCameraMetaMsg.errors),
    ).toBe(true);
    expect(JSON.stringify(meta)).not.toMatch(/-raw/);
  });

  it("hashes the same id differently under another session's salt", async () => {
    const a = await cameraMeta(setup(), PROBE, ENCODER, SALT);
    const b = await cameraMeta(setup(), PROBE, ENCODER, new Uint8Array(16));
    expect(a.devices![0]!.device_id_hash).not.toBe(
      b.devices![0]!.device_id_hash,
    );
  });

  it("still builds where getCapabilities or enumerateDevices is missing", async () => {
    installMedia({
      enumerateDevices: async () => {
        throw new DOMException("no", "NotAllowedError");
      },
    });
    const track = new FakeTrack({
      settings: SETTINGS,
      capabilities: undefined,
    });
    const meta = await cameraMeta(
      track as unknown as MediaStreamTrack,
      PROBE,
      { impl: "unknown" },
      SALT,
    );
    expect(meta.devices).toEqual([]);
    expect(meta.capabilities).toEqual({});
    expect(validateCameraMetaMsg(JSON.parse(JSON.stringify(meta)))).toBe(true);
  });
});
