/**
 * governance_bundle: everything an agent reads from Notion governance at session start, in one
 * live call. Stores and guides are resolved through the README's own tables (readme-tables.ts),
 * so no workspace IDs live in code. Names below are generic store and property roles; rename
 * them here if your workspace uses different ones.
 */
import type { NotionRequest } from "./notion.ts";
import { resolveGuide, resolveStore, type Resolved } from "./readme-tables.ts";
import { compactFields, type Field } from "./shape.ts";
import { MAX_TEXT } from "./text.ts";
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

/** The core sections, in output order. A call returns all of them unless `sections` says otherwise. */
export const SECTIONS = ["readme", "activity_log_fields", "preferences"] as const;
export type Section = (typeof SECTIONS)[number];

export interface BundleInput {
  scope?: string;
  guides?: string[];
  schemas?: string[];
  /** Core sections to return; omitted = all. [] returns only the named guides and schemas. */
  sections?: readonly Section[];
}

type Fields = { data_source_id: string; fields: Field[] };
type PreferenceRow = { Preference?: string; Strength?: string; Scope?: string[] };

export interface Bundle {
  errors: { section: string; message: string }[];
  readme?: { id: string; markdown: string | null };
  activity_log_fields?: Fields | null;
  preferences?: { scope: string | null; rows: PreferenceRow[] } | null;
  schemas?: Record<string, Fields | null>;
  guides?: Record<string, { id: string; markdown: string } | null>;
  /** What didn't fit in this reply, as the arguments of the call that returns it. */
  pending?: BundleInput;
}

export const README_TRUNCATED = "Notion marked the README truncated; tables past the cut can't be read";

type Markdown = { markdown?: unknown; truncated?: unknown; unknown_block_ids?: unknown[] };
type Query = { results?: { properties?: Record<string, unknown> }[]; has_more?: boolean; next_cursor?: string | null };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const unrendered = (d: Markdown): string[] =>
  Array.isArray(d?.unknown_block_ids) ? d.unknown_block_ids.map(String) : [];
/** Notion's note for blocks it couldn't render (often a child page or block not shared with the integration). */
const unrenderedNote = (what: string, ids: string[]) =>
  `Notion didn't render ${ids.length} block(s) of ${what} (not shared with the integration?): ${ids.join(", ")}`;

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
  const truncated = Boolean(md.truncated);

  const errors: Bundle["errors"] = [];
  const want = new Set<Section>(input.sections ?? SECTIONS);
  // The README is always read (its tables resolve everything else) but returned only when asked for.
  const bundle: Bundle = { errors, ...(want.has("readme") ? { readme: { id: readmeId, markdown } } : {}) };
  if (truncated) errors.push({ section: "readme", message: README_TRUNCATED });
  const skipped = unrendered(md);
  if (skipped.length) errors.push({ section: "readme", message: unrenderedNote("the README", skipped) });

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
    const props = (ds as { properties?: Record<string, { type?: string; select?: { options?: unknown[] } }> })?.properties ?? {};
    const missing = [STATUS, ...PREFERENCE_FIELDS].filter((p) => !(p in props));
    if (missing.length) throw new Error(`${PREFERENCES} is missing propert${missing.length > 1 ? "ies" : "y"}: ${missing.join(", ")}`);
    // A renamed option would otherwise match nothing and look like "no preferences apply".
    if (!options.includes(WHOLE_WORKSPACE)) {
      throw new Error(`${PREFERENCES} '${SCOPE}' has no '${WHOLE_WORKSPACE}' option. Options: ${options.join(", ")}`);
    }
    const status = props[STATUS];
    if (status?.type !== "select") {
      throw new Error(`${PREFERENCES} '${STATUS}' must be a select property (it is ${status?.type ?? "missing"})`);
    }
    const statusOptions = (status.select?.options ?? []).map((o) => (typeof o === "string" ? o : String((o as { name?: unknown })?.name ?? "")));
    if (!statusOptions.includes(ADOPTED)) {
      throw new Error(`${PREFERENCES} '${STATUS}' has no '${ADOPTED}' option. Options: ${statusOptions.join(", ")}`);
    }
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
    want.has("activity_log_fields") ? section("activity_log_fields", () => fieldsOf(ACTIVITY_LOG)) : undefined,
    want.has("preferences") ? section("preferences", preferences) : undefined,
    input.schemas?.length ? named("schemas", input.schemas, fieldsOf) : undefined,
    input.guides?.length
      ? named("guides", input.guides, async (n) => {
          const id = must(resolveGuide(markdown, n));
          const g = (await get(`/v1/pages/${id}/markdown`)) as Markdown;
          if (typeof g?.markdown !== "string") throw new Error(`Guide "${n}" (${id}) returned no markdown`);
          if (g.truncated) errors.push({ section: `guides.${n}`, message: `Notion marked guide "${n}" truncated` });
          const gs = unrendered(g);
          if (gs.length) errors.push({ section: `guides.${n}`, message: unrenderedNote(`guide "${n}"`, gs) });
          return { id, markdown: g.markdown };
        })
      : undefined,
  ]);
  if (al !== undefined) bundle.activity_log_fields = al;
  if (prefs !== undefined) bundle.preferences = prefs;
  if (schemas) bundle.schemas = schemas;
  if (guides) bundle.guides = guides;
  return bundle;
}

/** Room kept for `errors` and `pending` when judging whether one item could ever fit in a reply. */
const FIT_SLACK = 1_000;

/**
 * Make a bundle fit one reply by whole sections, so the JSON is always valid. Core sections go
 * in first, then schemas, then guides, each in the order asked for; an item that doesn't fit is
 * skipped (later, smaller ones still go in) and listed in `pending`, which is exactly the
 * arguments of the follow-up call. An item too long for any reply would stay pending forever,
 * so it becomes null plus an `errors` entry naming the notion_request call that reads it.
 */
export function fitBundle(bundle: Bundle, scope?: string, budget = MAX_TEXT): Bundle {
  const size = (v: unknown) => JSON.stringify(v).length;
  if (size(bundle) <= budget) return bundle;

  const errors = [...bundle.errors];
  const tooLong = (v: unknown) => size(v) + FIT_SLACK > budget;
  const giveUp = (section: string, what: string, v: unknown, read: string) =>
    errors.push({ section, message: `${what} is ${size(v)} chars, too long for one reply. Read it with notion_request ${read}` });
  const pageRead = (id: string) => `GET /v1/pages/${id}/markdown and follow its offset marker.`;

  type Item = { kind: "sections" | "schemas" | "guides"; name: string; value: unknown };
  const items: Item[] = [];
  if (bundle.readme) {
    let readme = bundle.readme;
    if (tooLong(readme)) {
      giveUp("readme", "The README", readme, pageRead(readme.id));
      readme = { id: readme.id, markdown: null };
    }
    items.push({ kind: "sections", name: "readme", value: readme });
  }
  for (const name of ["activity_log_fields", "preferences"] as const) {
    if (!(name in bundle)) continue;
    let value = bundle[name] ?? null;
    if (value && tooLong(value)) {
      const read = "data_source_id" in value ? `GET /v1/data_sources/${value.data_source_id}` : `on the ${PREFERENCES} store (POST /v1/data_sources/{id}/query).`;
      giveUp(name, name, value, read);
      value = null;
    }
    items.push({ kind: "sections", name, value });
  }
  for (const [name, v] of Object.entries(bundle.schemas ?? {})) {
    const over = v && tooLong(v);
    if (over) giveUp(`schemas.${name}`, `Schema "${name}"`, v, `GET /v1/data_sources/${v.data_source_id}`);
    items.push({ kind: "schemas", name, value: over ? null : v });
  }
  for (const [name, v] of Object.entries(bundle.guides ?? {})) {
    const over = v && tooLong(v);
    if (over) giveUp(`guides.${name}`, `Guide "${name}"`, v, pageRead(v.id));
    items.push({ kind: "guides", name, value: over ? null : v });
  }

  const build = (keep: Set<Item>): Bundle => {
    const out: Record<string, unknown> = { errors };
    const left: Item[] = [];
    for (const it of items) {
      if (!keep.has(it)) left.push(it);
      else if (it.kind === "sections") out[it.name] = it.value;
      else ((out[it.kind] ??= {}) as Record<string, unknown>)[it.name] = it.value;
    }
    if (left.length) {
      const names = (kind: Item["kind"]) => left.filter((it) => it.kind === kind).map((it) => it.name);
      const [schemas, guides] = [names("schemas"), names("guides")];
      out.pending = {
        sections: names("sections"),
        ...(schemas.length ? { schemas } : {}),
        ...(guides.length ? { guides } : {}),
        ...(scope !== undefined && names("sections").includes("preferences") ? { scope } : {}),
      };
    }
    return out as unknown as Bundle;
  };

  // A null (failed or given-up) item is a few chars and says something the caller needs: always kept.
  const keep = new Set(items.filter((it) => it.value === null));
  for (const it of items) {
    if (keep.has(it)) continue;
    keep.add(it);
    if (size(build(keep)) > budget) keep.delete(it);
  }
  return build(keep);
}
