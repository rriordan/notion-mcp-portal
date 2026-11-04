export const MAX_TEXT = 24_000; // chars returned to the model per call

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A list response that's too long keeps as many whole rows as fit, so the JSON stays valid
 * and the model can ask for the rest with a smaller page or fewer properties.
 */
function fitList(value: Obj, budget: number): string | null {
  const rows = value.results;
  if (!Array.isArray(rows) || rows.length < 2) return null;
  for (let keep = rows.length - 1; keep >= 1; keep--) {
    const out = {
      ...value,
      results: rows.slice(0, keep),
      truncated_rows: rows.length - keep,
      hint:
        `${rows.length - keep} of ${rows.length} rows left out to fit. Request page_size=${keep} ` +
        `(page on with next_cursor), or return less per row: query filter_properties, format "values".`,
    };
    const t = JSON.stringify(out);
    if (t.length <= budget) return t;
  }
  return null;
}

/**
 * Wrap a value as an MCP text result: compact JSON (no indentation), at most MAX_TEXT chars.
 * A long list keeps whole rows; any other long text is cut, with a marker giving the
 * `offset` that returns the next part.
 */
export function text(value: unknown, isError = false, offset = 0) {
  let t = typeof value === "string" ? value : JSON.stringify(value);
  if (offset === 0 && t.length > MAX_TEXT && isObj(value)) t = fitList(value, MAX_TEXT) ?? t;
  if (offset > 0 || t.length > MAX_TEXT) {
    const total = t.length;
    const start = Math.min(Math.max(0, offset), total);
    const end = Math.min(start + MAX_TEXT, total);
    t = t.slice(start, end);
    if (start > 0) t = `…[chars ${start}–${end} of ${total}]\n` + t;
    if (end < total) {
      t += `\n…[truncated: ${total - end} more chars. Call again with the same arguments and offset=${end}]`;
    }
  }
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
