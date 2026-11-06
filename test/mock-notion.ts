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

export async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const m = url.pathname.match(/^\/v1\/data_sources\/mock-ds\/query$/);
  if (!m || init?.method !== "POST") {
    return new Response(JSON.stringify({ object: "error", status: 404, code: "object_not_found", message: "mock: not found" }), { status: 404 });
  }
  stats.notionCalls++;
  const body = JSON.parse(String(init?.body ?? "{}")) as { page_size?: number; start_cursor?: string };
  const size = Math.min(body.page_size ?? 100, 100);
  const start = body.start_cursor ? Number(body.start_cursor.replace("after-", "")) : 0;
  const end = Math.min(start + size, TOTAL);
  const more = end < TOTAL;
  return new Response(
    JSON.stringify({
      object: "list",
      results: Array.from({ length: end - start }, (_, k) => row(start + k)),
      next_cursor: more ? `after-${end}` : null,
      has_more: more,
      type: "page_or_data_source",
      page_or_data_source: {},
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
