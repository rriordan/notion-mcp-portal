/**
 * Retry and error wording for calls to Notion.
 *
 *  - 429: Notion refused the call before running it, so it is safe to repeat for any method.
 *    Wait as long as Retry-After says (capped), up to MAX_RETRIES times.
 *  - 502/503/504 and network failures: the call may or may not have run. Repeat only requests
 *    that change nothing (idempotent); a write is reported, never re-sent.
 *  - Timeouts: every attempt gets `timeoutMs` (reply headers and a 2xx body; a stalled error body is
 *    dropped instead, see timedFetch in notion.ts). A read that times out is
 *    tried once more; a write that times out is never re-sent, since it may have landed. Timeouts
 *    are counted apart from the MAX_RETRIES network and 5xx retries, so they don't use those up.
 *  - A write whose 2xx status arrived but whose body was lost is reported as reply_lost: it landed.
 *  - Everything else is final.
 */
export const MAX_RETRIES = 3;
/** Extra attempts after a timeout, for idempotent calls only. */
export const MAX_TIMEOUT_RETRIES = 1;
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
  | "network"
  | "timeout"
  | "reply_lost";

/**
 * A call that got no usable reply; `cls` says whether it timed out, failed on the network, or (a
 * write only) got a 2xx status whose body was then lost. `retries` is how many times it was re-sent;
 * `status` is the HTTP status for reply_lost, else 0.
 */
export class FetchFailure extends Error {
  readonly cls: "network" | "timeout" | "reply_lost";
  readonly retries: number;
  readonly status: number;
  constructor(message: string, cls: "network" | "timeout" | "reply_lost", retries: number, status = 0) {
    super(message);
    this.name = "FetchFailure";
    this.cls = cls;
    this.retries = retries;
    this.status = status;
  }
}

const isTimeout = (e: unknown) => (e as { name?: unknown } | null)?.name === "TimeoutError";

/**
 * One attempt. `onHead` lets it hand over a reply as soon as its status and headers are in, before
 * its body is read (see timedFetch in notion.ts).
 */
export type DoFetch = (signal: AbortSignal, onHead?: (head: Response) => void) => Promise<Response>;

/**
 * Run one attempt under its own timeout. Raced against the signal as well as passed to it, so an
 * attempt that ignores the signal (a body that stalls, a fake fetch) still ends on time.
 * `seen.head` is set once the reply's status and headers are in.
 */
function attemptWithTimeout(doFetch: DoFetch, timeoutMs: number | undefined, seen: { head?: Response }): Promise<Response> {
  if (!timeoutMs) return doFetch(new AbortController().signal, (h) => (seen.head = h));
  // A plain setTimeout, not AbortSignal.timeout: Node doesn't keep its process alive for the
  // latter's timer, so a test whose fake fetch never settles would end before the timeout fires.
  const ac = new AbortController();
  const signal = ac.signal;
  const timer = setTimeout(() => ac.abort(new DOMException(`no reply in ${timeoutMs} ms`, "TimeoutError")), timeoutMs);
  // Once a non-2xx status and headers are in, that reply is the outcome: if the deadline comes
  // while its body is still being read, the attempt resolves with the head (empty body) rather
  // than timing out, so a 429 or 5xx is still handled by its status and Retry-After. A 2xx head is
  // never the outcome on its own (its body is the result): the attempt times out, and
  // fetchWithRetry sees `seen.head` to report a write as reply_lost.
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => (seen.head && !seen.head.ok ? resolve(seen.head) : reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    doFetch(signal, (h) => (seen.head = h))
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      });
  });
}

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
  doFetch: DoFetch,
  opts: { idempotent: boolean; sleep?: (ms: number) => Promise<void>; timeoutMs?: number },
): Promise<{ res: Response; retries: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  let timeouts = 0;
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let failure: unknown;
    const seen: { head?: Response } = {};
    try {
      res = await attemptWithTimeout(doFetch, opts.timeoutMs, seen);
    } catch (e) {
      failure = e;
    }
    // A write whose 2xx status arrived but whose body was then lost (connection drop or stall past
    // the deadline): Notion has confirmed it, so it is not "may have landed". A read is just retried.
    if (!res && seen.head?.ok && !opts.idempotent) {
      const status = seen.head.status;
      throw new FetchFailure(
        `Notion API ${status}: Notion accepted this write, but the reply body was lost [class=reply_lost; not repeated: the write landed in Notion. Find it by a stable identifier (for a create, query for a unique property value); don't resend]`,
        "reply_lost",
        attempt,
        status,
      );
    }
    if (!res && isTimeout(failure)) {
      const s = (opts.timeoutMs ?? 0) / 1000;
      if (!opts.idempotent) {
        throw new FetchFailure(
          `Notion API timeout: no reply in ${s} s [class=timeout; not repeated: this request may have landed in Notion, or may still land after a delay. Check for it by a stable identifier (for a create, query for a unique property value); don't resend just because a first read-back shows nothing]`,
          "timeout",
          attempt,
        );
      }
      if (timeouts < MAX_TIMEOUT_RETRIES) {
        timeouts++;
        await sleep(250);
        continue;
      }
      throw new FetchFailure(`Notion API timeout: no reply in ${s} s, tried twice [class=timeout; retryable later]`, "timeout", attempt);
    }
    // Timeouts have their own budget, so they don't count against MAX_RETRIES.
    const last = attempt - timeouts >= MAX_RETRIES;
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
    throw new FetchFailure(
      `Notion API network error: ${why} [class=network; ${opts.idempotent ? "retried, still failing" : "not repeated: this request may have changed Notion, read it back before trying again"}]`,
      "network",
      attempt,
    );
  }
}
