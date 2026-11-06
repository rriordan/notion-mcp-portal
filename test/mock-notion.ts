// LOCAL TESTING ONLY. A stand-in for api.notion.com: one data source with 250 wide rows, paged by
// page_size and start_cursor like the real one. Used by dev-entry-mock.ts; never deployed.
const TOTAL = 250;
const WIDE = 900; // chars of text per row, so 100 rows are far over the reply cap

const row = (i: number) => ({
  object: "page",
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  created_time: "2026-01-01T00:00:00.000Z",
  last_edited_time: "2026-01-02T00:00:00.000Z",
  archived: false,
  properties: {
    Name: { id: "title", type: "title", title: [{ type: "text", text: { content: `Row ${i}` }, plain_text: `Row ${i}` }] },
    Notes: { id: "n", type: "rich_text", rich_text: [{ type: "text", text: { content: "w".repeat(WIDE) }, plain_text: "w".repeat(WIDE) }] },
  },
});

export const stats = { notionCalls: 0 };

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/** A page of `total` items, paged by page_size and start_cursor like the real list endpoints. */
function listPage(total: number, size: number, cursor: string | null, item: (i: number) => unknown, extra: object = {}) {
  const start = cursor ? Number(cursor.replace("after-", "")) : 0;
  const end = Math.min(start + Math.min(size, 100), total);
  const more = end < total;
  return json({
    object: "list",
    results: Array.from({ length: end - start }, (_, k) => item(start + k)),
    next_cursor: more ? `after-${end}` : null,
    has_more: more,
    ...extra,
  });
}

const text = (i: number, prefix: string) => ({
  type: "text",
  text: { content: `${prefix} ${i} ${"w".repeat(WIDE)}` },
  plain_text: `${prefix} ${i} ${"w".repeat(WIDE)}`,
});
const id = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;

// Other list endpoints, each 120 wide items: search, block children, comments, property items, users.
const OTHER: Record<string, (size: number, cursor: string | null) => Response> = {
  "POST /v1/search": (n, c) => listPage(120, n, c, row, { type: "page_or_data_source", page_or_data_source: {} }),
  "GET /v1/blocks/mock-b/children": (n, c) =>
    listPage(120, n, c, (i) => ({ object: "block", id: id(i), type: "paragraph", paragraph: { rich_text: [text(i, "Block")] } }), { type: "block", block: {} }),
  "GET /v1/comments": (n, c) =>
    listPage(120, n, c, (i) => ({ object: "comment", id: id(i), rich_text: [text(i, "Comment")] }), { type: "comment", comment: {} }),
  "GET /v1/pages/mock-p/properties/mock-prop": (n, c) =>
    listPage(120, n, c, (i) => ({ object: "property_item", id: id(i), type: "relation", relation: { id: id(i) }, pad: "w".repeat(WIDE) }), {
      type: "property_item",
      property_item: { id: "mock-prop", type: "relation", relation: {}, next_url: null },
    }),
  "GET /v1/users": (n, c) =>
    listPage(120, n, c, (i) => ({ object: "user", id: id(i), type: "person", name: `User ${i} ${"w".repeat(WIDE)}` }), { type: "user", user: {} }),
};

export async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = init?.method ?? "GET";
  const body = method === "POST" ? (JSON.parse(String(init?.body ?? "{}")) as { page_size?: number; start_cursor?: string }) : {};
  const size = Number(body.page_size ?? url.searchParams.get("page_size") ?? 100);
  const cursor = body.start_cursor ?? url.searchParams.get("start_cursor");
  if (method === "POST" && /^\/v1\/data_sources\/mock-ds\/query$/.test(url.pathname)) {
    stats.notionCalls++;
    return listPage(TOTAL, size, cursor, row, { type: "page_or_data_source", page_or_data_source: {} });
  }
  const other = OTHER[`${method} ${url.pathname}`];
  if (other) {
    stats.notionCalls++;
    return other(size, cursor);
  }
  return json({ object: "error", status: 404, code: "object_not_found", message: "mock: not found" }, 404);
}
