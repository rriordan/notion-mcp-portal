/**
 * format "values": each page becomes { id, url, last_edited_time, props: { Name: value } }.
 * Property type wrappers, empty properties and page metadata (parent, created_by, icon…)
 * are left out; formulas and rollups become their computed value. Anything that isn't a page
 * goes through compactNotion unchanged, so non-row responses still read normally.
 */
import { compactNotion } from "./compact.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const plain = (rt: unknown): string =>
  Array.isArray(rt) ? rt.map((x) => (isObj(x) && typeof x.plain_text === "string" ? x.plain_text : "")).join("") : "";

const ids = (arr: unknown): unknown[] => (Array.isArray(arr) ? arr.map((x) => (isObj(x) ? (x.id ?? x.name) : x)) : []);

function dateValue(d: unknown): unknown {
  if (!isObj(d)) return null;
  return d.end ? `${d.start}/${d.end}` : d.start;
}

/** The value of one property object, or null/"" /[] when empty. */
export function propertyValue(prop: unknown): unknown {
  if (!isObj(prop) || typeof prop.type !== "string") return prop;
  const v = prop[prop.type];
  switch (prop.type) {
    case "title":
    case "rich_text":
      return plain(v);
    case "select":
    case "status":
      return isObj(v) ? v.name : null;
    case "multi_select":
      return Array.isArray(v) ? v.map((o) => (isObj(o) ? o.name : o)) : [];
    case "date":
      return dateValue(v);
    case "people":
    case "relation":
      return ids(v);
    case "created_by":
    case "last_edited_by":
      return isObj(v) ? v.id : v;
    case "files":
      return Array.isArray(v) ? v.map((f) => (isObj(f) ? f.name : f)) : [];
    case "unique_id":
      return isObj(v) ? (v.prefix ? `${v.prefix}-${v.number}` : v.number) : v;
    case "verification":
      return isObj(v) ? v.state : v;
    case "formula":
      return isObj(v) && typeof v.type === "string" ? (v.type === "date" ? dateValue(v.date) : v[v.type]) : v;
    case "rollup": {
      if (!isObj(v) || typeof v.type !== "string") return v;
      if (v.type === "date") return dateValue(v.date);
      if (v.type !== "array") return v[v.type];
      const items = (Array.isArray(v.array) ? v.array : []).map(propertyValue);
      return items.flatMap((x) => (Array.isArray(x) ? x : [x])).filter((x) => !isEmpty(x));
    }
    default:
      return v ?? null;
  }
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

function pageValues(page: Obj): Obj {
  const props: Obj = {};
  // Relations with more items than Notion sent: name -> property id, so the model can fetch
  // the rest with GET /v1/pages/{page_id}/properties/{property_id}.
  const incomplete: Obj = {};
  for (const [name, prop] of Object.entries(isObj(page.properties) ? page.properties : {})) {
    const v = propertyValue(prop);
    if (!isEmpty(v)) props[name] = v;
    if (isObj(prop) && prop.has_more === true) incomplete[name] = prop.id;
  }
  const out: Obj = { id: page.id, url: page.url, last_edited_time: page.last_edited_time, props };
  if (Object.keys(incomplete).length) out.incomplete = incomplete;
  if (page.in_trash === true) out.in_trash = true;
  return out;
}

export function valuesNotion(value: unknown): unknown {
  if (isObj(value) && value.object === "page" && isObj(value.properties)) return pageValues(value);
  // Only page lists are reshaped. Other lists (e.g. property items) carry data outside
  // results, such as a rollup's computed property_item, so they stay compact.
  if (
    isObj(value) &&
    value.object === "list" &&
    Array.isArray(value.results) &&
    value.results.every((r) => isObj(r) && r.object === "page")
  ) {
    const out: Obj = { results: value.results.map(valuesNotion), has_more: value.has_more };
    if (value.next_cursor) out.next_cursor = value.next_cursor;
    return out;
  }
  return compactNotion(value);
}
