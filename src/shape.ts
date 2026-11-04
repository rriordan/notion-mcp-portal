import { compactNotion, withHint } from "./compact.ts";
import { valuesNotion } from "./values.ts";

/** POST endpoints that only read; repeating them (for an offset) changes nothing. */
const READ_POSTS = [/^\/v1\/search\/?$/, /^\/v1\/(data_sources|databases)\/[^/]+\/query\/?$/];

/** Whether re-sending this request is safe: GET, or a POST that only reads. */
export function isReplayable(method: string, path: string): boolean {
  const p = path.split("?")[0];
  return method === "GET" || (method === "POST" && READ_POSTS.some((re) => re.test(p)));
}

/**
 * Shape a Notion response for the model. Outside raw, a page's markdown comes back as plain
 * Markdown (not a JSON string full of \n escapes), with Notion's truncation flags kept.
 */
export function shape(method: string, path: string, data: unknown, format?: string): unknown {
  if (format === "raw") return data;
  const d = data as { object?: string; markdown?: unknown; truncated?: unknown; unknown_block_ids?: unknown[] };
  if (d?.object === "page_markdown" && typeof d.markdown === "string") {
    const ids = Array.isArray(d.unknown_block_ids) ? d.unknown_block_ids : [];
    const notes = [
      d.truncated ? "Notion marked this page truncated." : "",
      ids.length ? `Blocks not rendered: ${ids.join(", ")} (GET /v1/blocks/{id}/children).` : "",
    ].filter(Boolean);
    return notes.length ? `${d.markdown}\n\n…[${notes.join(" ")}]` : d.markdown;
  }
  return withHint(method, path, format === "values" ? valuesNotion(data) : compactNotion(data));
}
