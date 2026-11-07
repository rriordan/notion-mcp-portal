import { MAX_TEXT } from "./text.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Room for the fields added around the rows (cursor, flags, note). */
const OVERHEAD = 500;
/** How many times to shrink page_size again if the rows turn out bigger than estimated. */
const MAX_REISSUES = 3;

/** A request with page_size set: in the body for POST (query, search), in the query string for GET. */
export function withPageSize<T extends { method: string; query?: Record<string, unknown>; body?: unknown }>(
  req: T,
  n: number,
): T | null {
  if (req.method === "GET") return { ...req, query: { ...req.query, page_size: n } };
  if (req.method === "POST" && (req.body === undefined || isObj(req.body))) {
    return { ...req, body: { ...(req.body as Obj | undefined), page_size: n } };
  }
  return null;
}

export interface Fitted {
  value: unknown;
  /** page_size the rows were fetched with, when the first response was too long for one reply. */
  reissued?: number;
  /** page_size of the reply returned, if it was lowered by us (reissued or started smaller). */
  fitted?: number;
}

/**
 * Fetch a list so that one reply holds whole rows AND a cursor that skips nothing.
 *
 * Notion's next_cursor points past every row it sent. If a reply is too long to carry them all,
 * cutting rows afterwards would leave a cursor that skips the cut rows (or no cursor at all, which
 * callers read as a lost cursor). Instead, send the same request again with a page_size that fits,
 * and return that second response whole: its rows and its cursor agree. The first response is
 * discarded entirely; rows are never mixed between the two, since an unsorted query can reorder
 * between calls.
 *
 * Only for requests that are safe to repeat. `fetchPage(undefined)` is the original request;
 * `fetchPage(n)` is the same request with page_size n (or null when that can't be expressed).
 * When no smaller page works, the first response comes back as is, for text() to cut.
 *
 * `startSize` is a page_size known to fit from an earlier call to the same endpoint: starting
 * there avoids the wasted first request. It is only a guess; the reply is still checked.
 */
export async function fetchFitted(
  fetchPage: (pageSize?: number) => Promise<unknown | null>,
  shape: (data: unknown) => unknown,
  opts: { budget?: number; startSize?: number } = {},
): Promise<Fitted> {
  const budget = opts.budget ?? MAX_TEXT;
  let data = opts.startSize ? await fetchPage(opts.startSize) : null;
  const started = data !== null;
  if (data === null) data = await fetchPage();
  const first = shape(data);
  const size = JSON.stringify(first)?.length ?? 0;
  const rows = isObj(first) && Array.isArray(first.results) ? first.results.length : 0;
  if (size <= budget || rows < 2) {
    if (!started || size > budget) return { value: first };
    // The note is part of the reply: check the annotated size, not the bare rows. A reply this close to
    // the cap goes out as fetched, without the note, rather than tip over and lose rows and cursor.
    const noted = annotate(first, opts.startSize!);
    if ((JSON.stringify(noted)?.length ?? 0) <= budget) return { value: noted, fitted: opts.startSize };
    return { value: first };
  }

  let keep = Math.max(1, Math.floor(((rows * (budget - OVERHEAD)) / size) * 0.9));
  for (let i = 0; i < MAX_REISSUES; i++) {
    if (keep >= rows) break;
    const again = await fetchPage(keep);
    if (again === null) break; // page_size can't be set on this request
    const value = shape(again);
    const len = JSON.stringify(value)?.length ?? 0;
    const got = isObj(value) && Array.isArray(value.results) ? value.results.length : 0;
    const noted = annotate(value, keep);
    if ((JSON.stringify(noted)?.length ?? 0) <= budget) return { value: noted, reissued: keep, fitted: keep };
    // Rows were bigger than the first page suggested: shrink in proportion and try again.
    keep = Math.max(1, Math.floor(((got || keep) * (budget - OVERHEAD)) / len * 0.9));
    if (got <= 1) break;
  }
  return { value: first };
}

function annotate(value: unknown, pageSize: number): unknown {
  if (!isObj(value)) return value;
  return {
    ...value,
    page_size_reduced_to: pageSize,
    note: `page_size lowered to ${pageSize} so this reply fits. ${
      value.has_more ? "Pass next_cursor as start_cursor for the next rows (keep this page_size, or let it be lowered again)." : "These are all the rows."
    }`,
  };
}
