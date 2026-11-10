/**
 * governance_bundle: everything an agent reads from Notion governance at session start, in one
 * live call. Stores and guides are resolved through the README's own tables (readme-tables.ts),
 * so no workspace IDs live in code. Names below are generic store and property roles; rename
 * them here if your workspace uses different ones.
 */
import type { NotionRequest } from "./notion.ts";
import { resolveGuide, resolveStore, type Resolved } from "./readme-tables.ts";
import { compactFields, type Field } from "./shape.ts";
import { propertyValue } from "./values.ts";

export const ACTIVITY_LOG = "Activity Log";
export const PREFERENCES = "Preferences";
export const STATUS = "Status";
export const ADOPTED = "Adopted";
export const SCOPE = "Scope";
export const WHOLE_WORKSPACE = "Whole workspace";
export const PREFERENCE_FIELDS = ["Preference", "Strength", "Scope"];

type Props = Record<string, { type?: string; multi_select?: { options?: unknown[] } }>;

/** The Scope property's option names, or null when the data source has no multi_select Scope. */
export function scopeOptions(dataSource: unknown): string[] | null {
  const p = ((dataSource as { properties?: Props })?.properties ?? {})[SCOPE];
  if (p?.type !== "multi_select" || !Array.isArray(p.multi_select?.options)) return null;
  return p.multi_select.options.map((o) => (typeof o === "string" ? o : String((o as { name?: unknown })?.name ?? "")));
}

/** One page of Adopted Preferences for `scope` plus Whole workspace (only Whole workspace when scope is null). */
export function preferencesRequest(dataSourceId: string, scope: string | null, cursor?: string): NotionRequest {
  const contains = (v: string) => ({ property: SCOPE, multi_select: { contains: v } });
  const scopePart = scope === null ? contains(WHOLE_WORKSPACE) : { or: [contains(scope), contains(WHOLE_WORKSPACE)] };
  return {
    method: "POST",
    path: `/v1/data_sources/${dataSourceId}/query`,
    query: { filter_properties: PREFERENCE_FIELDS },
    noCache: true,
    body: {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
      filter: { and: [{ property: STATUS, select: { equals: ADOPTED } }, scopePart] },
    },
  };
}

export interface BundleInput {
  scope?: string;
  guides?: string[];
  schemas?: string[];
}

type Fields = { data_source_id: string; fields: Field[] };
type PreferenceRow = { Preference?: string; Strength?: string; Scope?: string[] };

export interface Bundle {
  errors: { section: string; message: string }[];
  readme: { id: string; markdown: string };
  activity_log_fields: Fields | null;
  preferences: { scope: string | null; rows: PreferenceRow[] } | null;
  schemas?: Record<string, Fields | null>;
  guides?: Record<string, { id: string; markdown: string } | null>;
}

export const README_TRUNCATED = "Notion marked the README truncated; tables past the cut can't be read";

type Markdown = { markdown?: unknown; truncated?: unknown; unknown_block_ids?: unknown[] };
type Query = { results?: { properties?: Record<string, unknown> }[]; has_more?: boolean; next_cursor?: string | null };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isCut = (d: Markdown) => Boolean(d?.truncated) || (Array.isArray(d?.unknown_block_ids) && d.unknown_block_ids.length > 0);

/**
 * Fetch the README, then everything it points at in parallel. Throws only when the README can't
 * be read; every other failure is a null section plus an entry in `errors` (always the first key).
 */
export async function buildBundle(
  readmeId: string,
  input: BundleInput,
  request: (r: NotionRequest) => Promise<unknown>,
): Promise<Bundle> {
  const get = (path: string) => request({ method: "GET", path, noCache: true });

  let md: Markdown;
  try {
    md = (await get(`/v1/pages/${readmeId}/markdown`)) as Markdown;
  } catch (e) {
    throw new Error(`Couldn't read the governance README ${readmeId}: ${message(e)}`);
  }
  if (typeof md?.markdown !== "string") throw new Error(`Governance README ${readmeId} returned no markdown`);
  const markdown = md.markdown;
  const truncated = isCut(md);

  const errors: Bundle["errors"] = [];
  const bundle: Bundle = { errors, readme: { id: readmeId, markdown }, activity_log_fields: null, preferences: null };
  if (truncated) errors.push({ section: "readme", message: README_TRUNCATED });

  /** Run one section; a resolve or Notion failure becomes an `errors` entry and null. */
  async function section<T>(name: string, work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (e) {
      errors.push({ section: name, message: message(e) });
      return null;
    }
  }
  const must = <T>(r: Resolved<T>): T => {
    if (r.ok) return r.value;
    throw new Error(truncated ? `${r.error} (the README was truncated, so the table may be past the cut)` : r.error);
  };
  const fieldsOf = async (store: string) => compactFields(await get(`/v1/data_sources/${must(resolveStore(markdown, store))}`));

  async function preferences(): Promise<NonNullable<Bundle["preferences"]>> {
    const id = must(resolveStore(markdown, PREFERENCES));
    const scope = input.scope ?? null;
    const queryAll = async () => {
      const rows: PreferenceRow[] = [];
      let cursor: string | undefined;
      do {
        const page = (await request(preferencesRequest(id, scope, cursor))) as Query;
        for (const r of page?.results ?? []) {
          const row: Record<string, unknown> = {};
          for (const f of PREFERENCE_FIELDS) {
            const v = propertyValue(r.properties?.[f]);
            if (v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) row[f] = v;
          }
          rows.push(row as PreferenceRow);
        }
        cursor = page?.has_more && page.next_cursor ? page.next_cursor : undefined;
      } while (cursor);
      return rows;
    };
    // The schema read (for scope validation) and the query run in parallel.
    const [ds, rows] = await Promise.all([get(`/v1/data_sources/${id}`), queryAll()]);
    const options = scopeOptions(ds);
    if (!options) throw new Error(`${PREFERENCES} has no multi_select '${SCOPE}' property`);
    const props = (ds as { properties?: Record<string, unknown> })?.properties ?? {};
    const missing = [STATUS, ...PREFERENCE_FIELDS].filter((p) => !(p in props));
    if (missing.length) throw new Error(`${PREFERENCES} is missing propert${missing.length > 1 ? "ies" : "y"}: ${missing.join(", ")}`);
    if (scope !== null && !options.includes(scope)) {
      throw new Error(`Unknown scope "${scope}". Valid: ${options.join(", ")}`);
    }
    return { scope, rows };
  }

  const named = async <T>(kind: "guides" | "schemas", names: string[], work: (n: string) => Promise<T>) => {
    const out: Record<string, T | null> = {};
    const results = await Promise.all(names.map((n) => section(`${kind}.${n}`, () => work(n))));
    names.forEach((n, i) => (out[n] = results[i]));
    return out;
  };

  const [al, prefs, schemas, guides] = await Promise.all([
    section("activity_log_fields", () => fieldsOf(ACTIVITY_LOG)),
    section("preferences", preferences),
    input.schemas?.length ? named("schemas", input.schemas, fieldsOf) : undefined,
    input.guides?.length
      ? named("guides", input.guides, async (n) => {
          const id = must(resolveGuide(markdown, n));
          const g = (await get(`/v1/pages/${id}/markdown`)) as Markdown;
          if (isCut(g)) errors.push({ section: `guides.${n}`, message: `Notion marked guide "${n}" truncated` });
          return { id, markdown: typeof g?.markdown === "string" ? g.markdown : "" };
        })
      : undefined,
  ]);
  bundle.activity_log_fields = al;
  bundle.preferences = prefs;
  if (schemas) bundle.schemas = schemas;
  if (guides) bundle.guides = guides;
  return bundle;
}
