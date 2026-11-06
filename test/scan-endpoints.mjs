// Pagination check for the other list endpoints, against the mock Notion (see test/mock-notion.ts):
// search, block children, comments, page property items, users. Each has 120 wide items, so a
// 100-item page is over the reply cap and has to be re-fetched smaller. Walks each to the end.
//   SMOKE_MCP_URL=http://127.0.0.1:8788/mcp node test/scan-endpoints.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.SMOKE_MCP_URL ?? "http://127.0.0.1:8788/mcp";
const TOTAL = 120;
const SPECS = [
  { name: "search", method: "POST", path: "/v1/search" },
  { name: "block children", method: "GET", path: "/v1/blocks/mock-b/children" },
  { name: "comments", method: "GET", path: "/v1/comments", query: { block_id: "mock-b" } },
  { name: "page property items", method: "GET", path: "/v1/pages/mock-p/properties/mock-prop" },
  { name: "users", method: "GET", path: "/v1/users" },
];

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const mcp = new Client({ name: "notion-mcp-scan-endpoints", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(URL_)));
for (const spec of SPECS) {
  const ids = [];
  let cursor;
  let pages = 0;
  let lost = 0;
  let cut = 0;
  let maxLen = 0;
  for (;;) {
    const args = { method: spec.method, path: spec.path };
    if (spec.method === "POST") args.body = cursor ? { start_cursor: cursor } : {};
    else args.query = { ...spec.query, ...(cursor ? { start_cursor: cursor } : {}) };
    const r = await mcp.callTool({ name: "notion_request", arguments: args });
    const t = r.content.map((c) => c.text ?? "").join("");
    if (r.isError) throw new Error(`${spec.name} page ${pages + 1}: ${t.slice(0, 200)}`);
    const j = JSON.parse(t);
    pages++;
    maxLen = Math.max(maxLen, t.length);
    for (const x of j.results ?? []) ids.push(x.id);
    if (j.truncated_rows) cut++;
    if (j.has_more && !j.next_cursor) lost++;
    if (!j.has_more || !j.next_cursor) break;
    cursor = j.next_cursor;
  }
  check(`${spec.name}: all ${TOTAL} items, none twice`, ids.length === TOTAL && new Set(ids).size === TOTAL, `${ids.length} items in ${pages} pages, max reply ${maxLen} chars`);
  check(`${spec.name}: no lost cursor, no cut rows`, lost === 0 && cut === 0);
}
await mcp.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
