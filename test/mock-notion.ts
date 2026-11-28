// LOCAL TESTING ONLY. A stand-in for api.notion.com: one data source with 250 wide rows, paged by
// page_size and start_cursor like the real one. Used by dev-entry-mock.ts; never deployed.
import { AL_DS, PREFS_DS } from "./fixtures/datasources.ts";
import { AL_ID, GUIDE_ID, LONG_A_ID, LONG_B_ID, PREFS_ID, README_MD } from "./fixtures/readme.ts";

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

// governance_bundle: the fixture README, its two stores, one guide and one Preferences page.
const prefRow = {
  object: "page",
  id: "00000000-0000-0000-0000-000000000001",
  properties: {
    Preference: { type: "title", title: [{ type: "text", text: { content: "Be brief" }, plain_text: "Be brief" }] },
    Strength: { type: "select", select: { name: "Guardrail" } },
    Scope: { type: "multi_select", multi_select: [{ name: "Whole workspace" }] },
  },
};
const GOVERNANCE: Record<string, unknown> = {
  "GET /v1/pages/mock-readme/markdown": { object: "page_markdown", markdown: README_MD, truncated: false, unknown_block_ids: [] },
  [`GET /v1/data_sources/${AL_ID}`]: AL_DS,
  [`GET /v1/data_sources/${PREFS_ID}`]: PREFS_DS,
  [`POST /v1/data_sources/${PREFS_ID}/query`]: { object: "list", results: [prefRow], next_cursor: null, has_more: false },
  [`GET /v1/pages/${GUIDE_ID}/markdown`]: { object: "page_markdown", markdown: "# Tool Guide", truncated: false },
  // Two guides of 14,000 chars: with the core, one fits in a 24,000-char reply and the other doesn't.
  [`GET /v1/pages/${LONG_A_ID}/markdown`]: { object: "page_markdown", markdown: "a".repeat(14_000), truncated: false },
  [`GET /v1/pages/${LONG_B_ID}/markdown`]: { object: "page_markdown", markdown: "b".repeat(14_000), truncated: false },
};

export const stats = { notionCalls: 0 };

/** Calls per "METHOD path", readable through notion_request at GET /v1/mock/calls (format raw). */
const routeCalls: Record<string, number> = {};

// The Activity Log schema is mutable: PATCH /v1/data_sources/{AL_ID} with
// { properties: { Name: { description } } } changes a field description, as Notion would.
const alSchema: typeof AL_DS = structuredClone(AL_DS);
function patchActivityLog(body: { properties?: Record<string, { description?: string }> }): Response {
  for (const [name, change] of Object.entries(body.properties ?? {})) {
    const p = (alSchema.properties as Record<string, { description?: string | null }>)[name];
    if (!p) return json({ object: "error", status: 400, code: "validation_error", message: `mock: no property ${name}` }, 400);
    if (change.description !== undefined) p.description = change.description;
  }
  GOVERNANCE[`GET /v1/data_sources/${AL_ID}`] = alSchema;
  return json(alSchema);
}

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

// A data source with a status property, answering status group filters like Notion does with and
// without the status group filters beta. Every other route refuses a Notion-Beta header, so the
// other e2e scans also check that plain requests never send one.
const STATUS_BETA = "status-group-filters-2026-10-06";
const STATUS_ROWS = [
  { name: "Write spec", option: "In progress", group: "In progress" },
  { name: "Review PR", option: "In review", group: "In progress" },
  { name: "Ship", option: "Not started", group: "To-do" },
];
const statusPage = (r: (typeof STATUS_ROWS)[number], i: number) => ({
  object: "page",
  id: id(900 + i),
  properties: {
    Name: { id: "title", type: "title", title: [{ type: "text", text: { content: r.name }, plain_text: r.name }] },
    Status: { id: "s", type: "status", status: { name: r.option } },
  },
});

function statusQuery(body: { filter?: { status?: Record<string, unknown> } }, beta: string | null): Response {
  const status = body.filter?.status ?? {};
  const betaOn = (beta ?? "").split(",").includes(STATUS_BETA);
  if ("group_equals" in status && !betaOn) {
    return json(
      {
        object: "error",
        status: 400,
        code: "validation_error",
        message: `Status group operators require the "Notion-Beta: ${STATUS_BETA}" header. See https://developers.notion.com/reference/filter-data-source-entries#status-group-filters-beta.`,
      },
      400,
    );
  }
  const group = status.group_equals as string | undefined;
  const results = STATUS_ROWS.map(statusPage).filter((_, i) => !group || STATUS_ROWS[i].group === group);
  return json({ object: "list", results, next_cursor: null, has_more: false, type: "page_or_data_source", page_or_data_source: {} });
}

// /v1/pages/mock-slow (GET and PATCH) answers only after SLOW_MS, well past the mock config's
// NOTION_TIMEOUT_MS (300 ms reads, 900 ms writes), and gives up early when the caller aborts,
// as a real fetch would.
const SLOW_MS = 3_000;
function slowReply(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(json({ object: "page", id: "mock-slow" })), SLOW_MS);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
}

export async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = init?.method ?? "GET";
  const beta = new Headers(init?.headers).get("Notion-Beta");
  if (method === "GET" && url.pathname === "/v1/mock/calls") return json({ object: "mock_calls", calls: routeCalls });
  routeCalls[`${method} ${url.pathname}`] = (routeCalls[`${method} ${url.pathname}`] ?? 0) + 1;
  if (url.pathname === "/v1/pages/mock-slow" && (method === "GET" || method === "PATCH")) {
    stats.notionCalls++;
    return slowReply(init?.signal ?? undefined);
  }
  if (method === "PATCH" && url.pathname === `/v1/data_sources/${AL_ID}`) {
    stats.notionCalls++;
    return patchActivityLog(JSON.parse(String(init?.body ?? "{}")));
  }
  if (method === "POST" && url.pathname === "/v1/data_sources/mock-status/query") {
    stats.notionCalls++;
    return statusQuery(JSON.parse(String(init?.body ?? "{}")), beta);
  }
  if (beta !== null) {
    return json({ object: "error", status: 400, code: "validation_error", message: `mock: unexpected Notion-Beta header "${beta}"` }, 400);
  }
  const body = method === "POST" ? (JSON.parse(String(init?.body ?? "{}")) as { page_size?: number; start_cursor?: string }) : {};
  const size = Number(body.page_size ?? url.searchParams.get("page_size") ?? 100);
  const cursor = body.start_cursor ?? url.searchParams.get("start_cursor");
  if (method === "POST" && /^\/v1\/data_sources\/mock-ds\/query$/.test(url.pathname)) {
    stats.notionCalls++;
    return listPage(TOTAL, size, cursor, row, { type: "page_or_data_source", page_or_data_source: {} });
  }
  const gov = GOVERNANCE[`${method} ${url.pathname}`];
  if (gov) {
    stats.notionCalls++;
    return json(gov);
  }
  const other = OTHER[`${method} ${url.pathname}`];
  if (other) {
    stats.notionCalls++;
    return other(size, cursor);
  }
  return json({ object: "error", status: 404, code: "object_not_found", message: "mock: not found" }, 404);
}
