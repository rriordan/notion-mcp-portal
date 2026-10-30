/**
 * Compact a Notion API response for a model: drop what carries no information and collapse
 * verbose shapes to their value. Pass format: "raw" to notion_request to skip this.
 *
 *  - null fields, request_id, property ids, and in_trash/is_archived/is_locked/archived when false
 *  - rich-text arrays -> plain text (links as [text](url))
 *  - { object: "user", id } -> id
 *  - select/status/multi_select options { id, name, color } -> name
 */
const DROP_KEYS = new Set(["request_id"]);
const FALSE_FLAGS = new Set(["in_trash", "is_archived", "is_locked", "archived"]);
const RICH_TEXT_KEYS = new Set(["title", "rich_text", "caption", "description"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function isRichText(v: unknown): v is Obj[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && typeof x.plain_text === "string" && "type" in x);
}

function richTextToString(items: Obj[]): string {
  return items.map((x) => (typeof x.href === "string" ? `[${x.plain_text}](${x.href})` : (x.plain_text as string))).join("");
}

function isOption(v: Obj): boolean {
  return typeof v.name === "string" && "color" in v && Object.keys(v).every((k) => ["id", "name", "color", "description"].includes(k));
}

function isBareUser(v: Obj): boolean {
  return v.object === "user" && Object.keys(v).every((k) => k === "object" || k === "id");
}

export function compactNotion(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (isRichText(value)) return richTextToString(value);
    return value.map((v) => compactNotion(v));
  }
  if (!isObj(value)) return value;
  if (isBareUser(value)) return value.id;
  if (isOption(value)) return value.name;

  const out: Obj = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null || DROP_KEYS.has(key)) continue;
    if (FALSE_FLAGS.has(key) && v === false) continue;
    if (key === "properties" && isObj(v)) {
      // Each property drops its id (an opaque short code); names identify properties.
      out[key] = Object.fromEntries(
        Object.entries(v).map(([name, prop]) => {
          const p = compactNotion(prop);
          if (isObj(p)) delete p.id;
          return [name, p];
        }),
      );
      continue;
    }
    if (RICH_TEXT_KEYS.has(key) && Array.isArray(v) && v.length === 0) {
      out[key] = "";
      continue;
    }
    out[key] = compactNotion(v);
  }
  return out;
}
