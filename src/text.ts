export const MAX_TEXT = 24_000; // chars returned to the model per call

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A list response that's too long keeps as many whole rows as fit, so the JSON stays valid.
 * Notion's next_cursor points past every row it sent, including the ones left out here, so it
 * is dropped: the model re-sends the same request with a smaller page_size instead, which
 * returns these rows and a cursor that skips nothing.
 */
function fitList(value: Obj, budget: number): string | null {
  const rows = value.results;
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const { next_cursor: _dropped, ...rest } = value;
  for (let keep = rows.length - 1; keep >= 1; keep--) {
    const out = {
      ...rest,
      results: rows.slice(0, keep),
      has_more: true,
      truncated_rows: rows.length - keep,
      hint:
        `${rows.length - keep} of ${rows.length} rows left out to fit, and next_cursor removed because it would skip them. ` +
        `Re-send this same request with page_size=${keep}, or return less per row (query filter_properties, format "values").`,
    };
    const t = JSON.stringify(out);
    if (t.length <= budget) return t;
  }
  return null;
}

/**
 * Wrap a value as an MCP text result: compact JSON (no indentation), at most MAX_TEXT chars.
 * A long list keeps whole rows. Any other long text is cut; for a request that is safe to
 * repeat, the marker gives the `offset` that returns the next part. A write is never
 * repeated, so its marker says how to read the result back instead.
 */
export function text(value: unknown, isError = false, offset = 0, replayable = true) {
  let t = typeof value === "string" ? value : JSON.stringify(value);
  if (offset === 0 && t.length > MAX_TEXT && isObj(value)) t = fitList(value, MAX_TEXT) ?? t;
  if (offset > 0 || t.length > MAX_TEXT) {
    const total = t.length;
    const start = Math.min(Math.max(0, offset), total);
    const end = Math.min(start + MAX_TEXT, total);
    t = t.slice(start, end);
    if (start > 0) t = `…[chars ${start}–${end} of ${total}]\n` + t;
    if (end < total) {
      t += replayable
        ? `\n…[truncated: ${total - end} more chars. Call again with the same arguments and offset=${end}]`
        : `\n…[truncated: ${total - end} more chars. This request changed Notion, so don't repeat it; ` +
          `read the result back with a GET, e.g. GET /v1/pages/{id}]`;
    }
  }
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
