// The "Saved" column of the results table. A long list is cut to the rows that fit the reply
// cap, so raw and compact can come back with different row counts; comparing their totals
// then compares different amounts of data. With rows on both sides, compare per row instead.

/** Rows in a list reply, or null when the text isn't a JSON list. */
export function rowCount(text) {
  try {
    const rows = JSON.parse(text)?.results;
    return Array.isArray(rows) ? rows.length : null;
  } catch {
    return null;
  }
}

/** `raw` and `compact` are { size, rows, truncated? }; size is tokens or chars. */
export function savedCell(raw, compact) {
  if (raw.truncated) return "n/a (raw truncated)";
  const pct = (a, b) => `${Math.round((1 - b / a) * 100)}%`;
  if (raw.rows && compact.rows && raw.rows !== compact.rows) {
    return `${pct(raw.size / raw.rows, compact.size / compact.rows)} per row (${raw.rows} vs ${compact.rows} rows)`;
  }
  return pct(raw.size, compact.size);
}
