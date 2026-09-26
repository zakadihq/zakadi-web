/** An ingest candidate of the session (spec/02-api.md 2.2, spec/06-web-sdk.md 6.2.2). */
export interface IngestCandidate {
  region: string;
  url: string;
}

/** A ranked candidate; `warmMs` is its second probe sample, for telemetry and `connected` (6.2.10). */
export type RankedCandidate = IngestCandidate & { warmMs?: number };

/**
 * Region choice on the main thread (spec/05-sdk-contract.md 5.15, spec/06-web-sdk.md
 * 6.2.6): two `GET /v1/probe` per candidate, 2 s each. A page cannot force a fresh
 * connection, so the first (cold) sample ranks and the second only confirms
 * reachability. Ties keep list order, a failing candidate is skipped, and when all
 * fail the list is returned in its own order.
 */
export async function rankIngest(
  cands: IngestCandidate[],
): Promise<RankedCandidate[]> {
  const timed = await Promise.all(
    cands.map(async (c, i) => {
      const url = new URL("/v1/probe", c.url.replace(/^ws/, "http")).href;
      const t: number[] = [];
      for (let k = 0; k < 2; k++) {
        const t0 = performance.now();
        const ac = new AbortController();
        let id: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            fetch(url, {
              mode: "no-cors",
              cache: "no-store",
              credentials: "omit",
              signal: ac.signal,
            }),
            new Promise((_, reject) => {
              id = setTimeout(() => {
                ac.abort();
                reject(new Error("timeout"));
              }, 2000);
            }),
          ]);
        } catch {
          return { c, i, t: [Infinity] };
        } finally {
          clearTimeout(id);
        }
        t.push(performance.now() - t0);
      }
      return { c, i, t };
    }),
  );
  const ok = timed
    .filter((x) => x.t[0]! < Infinity)
    .sort((a, b) => a.t[0]! - b.t[0]! || a.i - b.i);
  return ok.length ? ok.map((x) => ({ ...x.c, warmMs: x.t[1]! })) : cands;
}
