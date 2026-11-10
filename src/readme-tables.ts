/**
 * Read store and guide IDs out of the governance README's own tables, so the README stays the
 * only place IDs live. Notion's page Markdown writes tables as `<table header-row="true">` HTML;
 * a small regex pass is enough (no DOM in a Worker). Tables are found by their `## ` heading and
 * columns by header text, never by position, so a reordered or widened table still resolves.
 */

/** README sections and columns this module reads. Rename here if your README differs. */
export const STORES_HEADING = "Where things go";
export const GUIDES_HEADING = "Guides";
export const DATA_SOURCE_COLUMN = "Data source";
export const GUIDE_COLUMN = "Guide";

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Table {
  headers: string[];
  rows: string[][];
}

const LINK = /\[([^\]]*)\]\(([^)\s]*)\)/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEX32 = /[0-9a-f]{32}/gi;

/** Case, spacing and Markdown emphasis don't count when matching a name. */
const norm = (s: string): string =>
  s.replace(/\*+/g, "").trim().replace(/^_+|_+$/g, "").replace(/\s+/g, " ").trim().toLowerCase();

const cells = (row: string): string[] =>
  [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1].trim());

/** The first `<table>` between the `## <heading>` line and the next heading of level 1–2. */
export function findTable(markdown: string, heading: string): Table | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^##\s/.test(l) && norm(l.replace(/^##\s+/, "")) === norm(heading));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
  if (end < 0) end = lines.length;
  const section = lines.slice(start + 1, end).join("\n");
  const table = section.match(/<table[^>]*>([\s\S]*?)<\/table>/);
  if (!table) return null;
  const rows = [...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => cells(m[1]));
  if (!rows.length) return null;
  return { headers: rows[0], rows: rows.slice(1) };
}

interface Entry {
  name: string;
  row: string[];
  link: string;
}

/** Look `name` up by link text in a table. `linkColumn` null = the first linked cell not in `skip`. */
function lookup(
  markdown: string,
  heading: string,
  kind: string,
  name: string,
  columns: { required: string[]; linkColumn: string | null; skip?: string },
): Resolved<{ entry: Entry; headers: string[] }> {
  const table = findTable(markdown, heading);
  if (!table) return { ok: false, error: `README has no '## ${heading}' table; cannot resolve ${kind} "${name}"` };
  for (const col of columns.required) {
    if (!table.headers.some((h) => norm(h) === norm(col))) {
      return { ok: false, error: `README '## ${heading}' table has no '${col}' column; cannot resolve ${kind} "${name}"` };
    }
  }
  const col = (c: string) => table.headers.findIndex((h) => norm(h) === norm(c));
  const linkIdx = columns.linkColumn ? col(columns.linkColumn) : -1;
  const skipIdx = columns.skip ? col(columns.skip) : -1;
  const entries: Entry[] = [];
  for (const row of table.rows) {
    const idx = linkIdx >= 0 ? linkIdx : row.findIndex((c, i) => i !== skipIdx && LINK.test(c));
    const m = idx >= 0 ? row[idx]?.match(LINK) : null;
    if (m) entries.push({ name: m[1].replace(/\*+/g, "").replace(/\s+/g, " ").trim(), row, link: m[2] });
  }
  const hits = entries.filter((e) => norm(e.name) === norm(name));
  if (hits.length > 1) {
    return { ok: false, error: `${kind} name "${name}" is ambiguous: ${hits.length} rows in README '## ${heading}'` };
  }
  if (!hits.length) {
    const valid = entries.map((e) => e.name).join(", ") || "(none)";
    return { ok: false, error: `No ${kind} named "${name}" in README '## ${heading}'. Valid: ${valid}` };
  }
  return { ok: true, value: { entry: hits[0], headers: table.headers } };
}

/** The data source UUID of the store whose link text matches `name`. */
export function resolveStore(markdown: string, name: string): Resolved<string> {
  const r = lookup(markdown, STORES_HEADING, "store", name, {
    required: [DATA_SOURCE_COLUMN],
    linkColumn: null,
    skip: DATA_SOURCE_COLUMN,
  });
  if (!r.ok) return r;
  const idx = r.value.headers.findIndex((h) => norm(h) === norm(DATA_SOURCE_COLUMN));
  const id = r.value.entry.row[idx]?.match(UUID)?.[0];
  if (!id) return { ok: false, error: `README '## ${STORES_HEADING}' row "${r.value.entry.name}" has no data source id` };
  return { ok: true, value: id.toLowerCase() };
}

/** The 32-hex page ID of the guide whose link text in the `Guide` column matches `name`. */
export function resolveGuide(markdown: string, name: string): Resolved<string> {
  const r = lookup(markdown, GUIDES_HEADING, "guide", name, { required: [GUIDE_COLUMN], linkColumn: GUIDE_COLUMN });
  if (!r.ok) return r;
  const id = r.value.entry.link.split(/[?#]/)[0].match(HEX32)?.pop();
  if (!id) return { ok: false, error: `README guide "${r.value.entry.name}" link has no page id` };
  return { ok: true, value: id.toLowerCase() };
}
