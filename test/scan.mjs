// Live pagination check: walk one data source query to the end through the MCP endpoint, twice,
// the way a scheduled agent does, and check the walk is complete and consistent.
//
//   SMOKE_MCP_URL=http://127.0.0.1:8787/mcp SCAN_DATA_SOURCE_ID=<id> node test/scan.mjs
//
// Optional: SCAN_BODY='{"filter":{...}}' (the query body, without page_size or start_cursor),
// SCAN_FORMAT=compact|values|raw (default compact), SCAN_DELAY_MS (default 2500).
// Read-only: every call is a query. The delay keeps Notion calls at or under 1 per second even
// when one MCP call makes two (a list that is too long is fetched again with a smaller page_size).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.SMOKE_MCP_URL ?? "http://127.0.0.1:8787/mcp";
const DS = process.env.SCAN_DATA_SOURCE_ID;
if (!DS) throw new Error("set SCAN_DATA_SOURCE_ID");
const BODY = process.env.SCAN_BODY ? JSON.parse(process.env.SCAN_BODY) : {};
const FORMAT = process.env.SCAN_FORMAT ?? "compact";
const DELAY = Number(process.env.SCAN_DELAY_MS ?? 2500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

async function scan(label) {
  // A fresh session per scan, like a scheduled run.
  const mcp = new Client({ name: "notion-mcp-scan", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  const ids = [];
  const sizes = [];
  let cursor;
  let pages = 0;
  let lostCursor = 0;
  let reduced = 0;
  let cut = 0;
  const started = Date.now();
  for (;;) {
    const body = { ...BODY, ...(cursor ? { start_cursor: cursor } : {}) };
    const r = await mcp.callTool({
      name: "notion_request",
      arguments: { method: "POST", path: `/v1/data_sources/${DS}/query`, body, format: FORMAT },
    });
    const t = r.content.map((c) => c.text ?? "").join("");
    if (r.isError) throw new Error(`${label} page ${pages + 1}: ${t.slice(0, 200)}`);
    const j = JSON.parse(t);
    pages++;
    sizes.push(t.length);
    for (const row of j.results ?? []) ids.push(row.id);
    if (j.page_size_reduced_to) reduced++;
    if (j.truncated_rows) cut++;
    if (j.has_more && !j.next_cursor) lostCursor++;
    if (!j.has_more) break;
    if (!j.next_cursor) break;
    cursor = j.next_cursor;
    await sleep(DELAY);
  }
  await mcp.close();
  console.log(`${label}: ${pages} pages, ${ids.length} rows, ${reduced} reduced, ${cut} cut, ${Date.now() - started} ms, max reply ${Math.max(...sizes)} chars`);
  return { ids, pages, lostCursor, cut };
}

const a = await scan("scan 1");
await sleep(DELAY);
const b = await scan("scan 2");
check("no reply had has_more without a next_cursor", a.lostCursor + b.lostCursor === 0);
check("no reply cut rows without a usable cursor", a.cut + b.cut === 0);
check("no row listed twice", new Set(a.ids).size === a.ids.length, `${a.ids.length} rows`);
check("two scans agree", a.ids.length === b.ids.length && a.ids.every((id) => b.ids.includes(id)), `${a.ids.length} vs ${b.ids.length}`);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
