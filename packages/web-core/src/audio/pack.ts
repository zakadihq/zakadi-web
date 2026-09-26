// The prompt pack (spec/05-sdk-contract.md 5.7, spec/06-web-sdk.md 6.2.9): the
// manifest and every file it names, six requests at a time within a 5 s budget, kept
// in Cache Storage `zakadi-pack:<lang>@<version>` or, where that refuses, in memory.
// Every file is checked against its manifest SHA-256 before it is cached or used and
// again when it is read back.
import type { Fields, TelemetryName } from "../telemetry/index.js";

/** A prompt pack as POST /v1/sessions names it (spec/02-api.md 2.2, 6.2.2). */
export interface PromptPackRef {
  lang: string;
  version: string;
  /** The manifest; the files sit beside it. */
  url: string;
}

/** One file of a pack, named relative to the manifest, with its SHA-256 in hex. */
export interface PackFile {
  file: string;
  sha256: string;
}

/** A cue: `m4a` in every pack, `ogg` when the pack lists it (5.7, D73). */
export interface CueEntry {
  dur_ms: number;
  m4a: PackFile;
  ogg?: PackFile;
}

/** The manifest of 5.7. */
export interface Manifest {
  lang: string;
  version: string;
  format: string[];
  cues: Record<string, CueEntry>;
  /** Eight [hue, saturation, lightness] entries, one per `tile.symbol`. */
  tile_palette: [number, number, number][];
  character?: { lottie: string; sha256: string; version?: number };
}

/** A loaded pack: its manifest, and the character's Lottie JSON or null (D73). */
export interface LoadedPack {
  manifest: Manifest;
  character: unknown;
}

/** Why a clip cannot play: the `reason` of `cue_missing`. */
export type Missing = "not_in_pack" | "not_loaded" | "sha256" | "decode";

/** A verified clip: its bytes until decoding starts, then the decoding. */
export interface Clip {
  dur: number;
  bytes: Uint8Array<ArrayBuffer> | null;
  buf?: Promise<AudioBuffer | null>;
}

/** One load of one pack; the next load aborts it. */
export interface Pack {
  ref: PromptPackRef;
  ctrl: AbortController;
  manifest?: Manifest;
  clips: Map<string, Clip>;
  failed: Map<string, Missing>;
}

/** No manifest within the budget: the session ends with `pack_unavailable`. */
export class PackUnavailableError extends Error {
  readonly code = "pack_unavailable";
}

export type Engine = "chromium" | "gecko" | "webkit" | "other";

/** The browser engine a user agent names; every iOS browser is WebKit. */
export function engineOf(ua: string): Engine {
  if (/iP(hone|ad|od)|CriOS|FxiOS|EdgiOS/.test(ua)) return "webkit";
  if (/Chrom(e|ium)\//.test(ua)) return "chromium";
  if (/Gecko\/\d/.test(ua)) return "gecko";
  return /AppleWebKit\//.test(ua) ? "webkit" : "other";
}

/**
 * `ogg` on Chromium and Gecko when the pack lists it, else `m4a`. WebKit decodes Ogg
 * Opus in Web Audio only from Safari 27, so it keeps `m4a` (D86).
 */
export function formatFor(manifest: Manifest, engine: Engine): "ogg" | "m4a" {
  return (engine === "chromium" || engine === "gecko") &&
    manifest.format.includes("ogg")
    ? "ogg"
    : "m4a";
}

const PREFIX = "zakadi-pack:";
const BUDGET_MS = 5000;
const PARALLEL = 6;
const RETRY_MS = 1000;
// The character's key among the clips; cue ids always hold a dot.
const CHARACTER = "character";

/**
 * Loads `pack`: resolves once every file is settled or the 5 s budget ran out, with
 * the files that did not load left to play caption-only; rejects with
 * PackUnavailableError when no manifest arrives. `onClip` sees each verified clip.
 */
export async function loadPack(
  pack: Pack,
  emit: (name: TelemetryName, fields: Fields) => void,
  onClip: (clip: Clip) => void,
): Promise<LoadedPack> {
  const { ref, ctrl } = pack;
  const t0 = performance.now();
  const name = PREFIX + ref.lang + "@" + ref.version;
  let cache: Cache | undefined;
  let network = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Missing>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve("not_loaded");
    }, BUDGET_MS);
  });

  // Cache first, then the network, for a file named relative to the manifest. `ok`
  // checks the bytes before they are cached or used; a cached copy that fails it is
  // deleted. A storage error counts as a miss.
  const read = async (
    file: string,
    ok: (bytes: Uint8Array<ArrayBuffer>) => boolean | Promise<boolean>,
  ): Promise<Uint8Array<ArrayBuffer> | Missing> => {
    try {
      const url = new URL(file, new URL(ref.url, globalThis.location?.href))
        .href;
      const hit = await cache?.match(url).catch(() => undefined);
      if (!hit) network = true;
      const res =
        hit ?? (await fetch(url, { signal: ctrl.signal, credentials: "omit" }));
      if (!res.ok) return "not_loaded";
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!(await ok(bytes))) {
        if (hit) await cache?.delete(url).catch(() => undefined);
        return "sha256";
      }
      if (!hit)
        await cache?.put(url, new Response(bytes)).catch(() => undefined);
      return bytes;
    } catch {
      return "not_loaded";
    }
  };

  let manifest: Manifest | undefined;
  const got = await Promise.race([
    (async () => {
      try {
        cache = await caches.open(name);
      } catch {
        // Memory only: no Cache Storage here, or it refuses this origin.
      }
      // A request that fails is made again every second within the budget, as
      // constrained networks drop them; a manifest that does not parse is final.
      const parse = (bytes: Uint8Array): boolean =>
        !!(manifest = parseManifest(bytes, ref));
      let bytes = await read(ref.url, parse);
      while (bytes === "not_loaded") {
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        if (ctrl.signal.aborted) break;
        bytes = await read(ref.url, parse);
      }
      return bytes;
    })(),
    expired,
  ]);
  if (typeof got === "string" || !manifest) {
    clearTimeout(timer);
    ctrl.abort();
    throw new PackUnavailableError("no prompt pack manifest at " + ref.url);
  }
  pack.manifest = manifest;
  // Older versions of this language are deleted, off the critical path.
  if (cache)
    void caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n.startsWith(PREFIX + ref.lang + "@") && n !== name)
            .map((n) => caches.delete(n)),
        ),
      )
      .catch(() => undefined);

  const format = formatFor(manifest, engineOf(navigator.userAgent));
  const jobs: [string, PackFile, number][] = [];
  for (const [id, entry] of Object.entries(manifest.cues)) {
    const file = entry?.[format] ?? entry?.m4a;
    if (
      typeof file?.file === "string" &&
      typeof file.sha256 === "string" &&
      entry.dur_ms > 0
    )
      jobs.push([id, file, entry.dur_ms]);
  }
  const character = manifest.character;
  let json: unknown = null;
  if (character)
    jobs.push([
      CHARACTER,
      { file: character.lottie, sha256: character.sha256 },
      0,
    ]);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length && !ctrl.signal.aborted) {
      const [id, file, dur] = jobs[next++] as [string, PackFile, number];
      const hash = file.sha256.toLowerCase();
      const bytes = await read(
        file.file,
        async (b) => (await sha256(b)) === hash,
      );
      if (typeof bytes === "string") {
        pack.failed.set(id, bytes);
      } else if (id !== CHARACTER) {
        const clip: Clip = { dur, bytes };
        pack.clips.set(id, clip);
        onClip(clip);
      } else {
        try {
          json = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          pack.failed.set(id, "decode");
        }
      }
    }
  };
  await Promise.race([
    Promise.all(Array.from({ length: PARALLEL }, worker)),
    expired,
  ]);
  clearTimeout(timer);
  // Without its character the tile shows its colour alone (D73).
  if (character && json === null)
    emit("cue_missing", {
      cue: CHARACTER,
      reason: pack.failed.get(CHARACTER) ?? "not_loaded",
    });
  emit("pack_fetch", {
    ms: Math.round(performance.now() - t0),
    cached: !network,
  });
  return { manifest, character: json };
}

function parseManifest(
  bytes: Uint8Array,
  ref: PromptPackRef,
): Manifest | undefined {
  try {
    const m = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
    const palette = m.tile_palette;
    if (
      m.lang === ref.lang &&
      m.version === ref.version &&
      Array.isArray(m.format) &&
      typeof m.cues === "object" &&
      m.cues !== null &&
      Array.isArray(palette) &&
      palette.length === 8 &&
      palette.every(
        (hsl) =>
          Array.isArray(hsl) && hsl.length === 3 && hsl.every(Number.isFinite),
      )
    )
      return m;
  } catch {
    // Not JSON: no manifest.
  }
  return undefined;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => (b + 256).toString(16).slice(1)).join("");
}
