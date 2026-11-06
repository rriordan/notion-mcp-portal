/**
 * Retry and error wording for calls to Notion.
 *
 *  - 429: Notion refused the call before running it, so it is safe to repeat for any method.
 *    Wait as long as Retry-After says (capped), up to MAX_RETRIES times.
 *  - 502/503/504 and network failures: the call may or may not have run. Repeat only requests
 *    that change nothing (idempotent); a write is reported, never re-sent.
 *  - Everything else is final.
 */
export const MAX_RETRIES = 3;
const MAX_WAIT_S = 10; // one wait
const MAX_TOTAL_WAIT_S = 20; // all waits in one call

export type ErrorClass =
  | "rate_limited"
  | "quota"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "upstream"
  | "network";

export function classify(status: number, code?: string): { cls: ErrorClass; retryable: boolean } {
  if (status === 429) return { cls: code === "usage_limit_reached" ? "quota" : "rate_limited", retryable: code !== "usage_limit_reached" };
  if (status === 401) return { cls: "unauthorized", retryable: false };
  if (status === 403) return { cls: "forbidden", retryable: false };
  if (status === 404) return { cls: "not_found", retryable: false };
  if (status === 409) return { cls: "conflict", retryable: true };
  if (status >= 500) return { cls: "upstream", retryable: true };
  return { cls: "invalid_request", retryable: false };
}

/** Retry-After in seconds (a number; an HTTP date is rare from Notion and falls back to 1). */
export function retryAfterSeconds(header: string | null): number {
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_WAIT_S) : 1;
}

/** The suffix that tells the model what kind of failure this is and whether repeating can help. */
export function errorTag(status: number, code: string | undefined, retryAfter: string | null, idempotent: boolean): string {
  const { cls, retryable } = classify(status, code);
  const parts = [`class=${cls}`, retryable && idempotent ? "retryable" : retryable ? "not repeated: this request changes Notion" : "not retryable"];
  if (status === 429 && retryAfter) parts.push(`retry_after=${retryAfter}s`);
  return ` [${parts.join("; ")}]`;
}

export async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  opts: { idempotent: boolean; sleep?: (ms: number) => Promise<void> },
): Promise<{ res: Response; retries: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let failure: unknown;
    try {
      res = await doFetch();
    } catch (e) {
      failure = e;
    }
    const last = attempt >= MAX_RETRIES;
    if (res) {
      if (res.status === 429 && !last) {
        const wait = retryAfterSeconds(res.headers.get("Retry-After"));
        if (waited + wait <= MAX_TOTAL_WAIT_S) {
          waited += wait;
          await sleep(wait * 1000);
          continue;
        }
      } else if ([502, 503, 504].includes(res.status) && opts.idempotent && !last) {
        await sleep(Math.min(250 * 2 ** attempt, 2000));
        continue;
      }
      return { res, retries: attempt };
    }
    if (opts.idempotent && !last) {
      await sleep(Math.min(250 * 2 ** attempt, 2000));
      continue;
    }
    const why = failure instanceof Error ? failure.message : String(failure);
    throw new Error(
      `Notion API network error: ${why} [class=network; ${opts.idempotent ? "retried, still failing" : "not repeated: this request may have changed Notion, read it back before trying again"}]`,
    );
  }
}
