/**
 * governance_bundle: everything an agent reads from Notion governance at session start, in one
 * live call. Stores and guides are resolved through the README's own tables (readme-tables.ts),
 * so no workspace IDs live in code. Names below are generic store and property roles; rename
 * them here if your workspace uses different ones.
 */
import type { NotionRequest } from "./notion.ts";

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
