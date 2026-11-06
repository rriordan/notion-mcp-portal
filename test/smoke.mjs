// Live smoke test: read-only checks of a running server (local `npm run dev` or a deployed URL).
//
//   SMOKE_MCP_URL=http://127.0.0.1:8787/mcp SMOKE_DATA_SOURCE_ID=<id> node test/smoke.mjs
//
// Every Notion call is a GET or a query POST. The one write-shaped call (POST with an offset)
// must be refused by the server before it reaches Notion. Needs a server with a real NOTION_TOKEN.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.SMOKE_MCP_URL ?? "http://127.0.0.1:8787/mcp";
const DS = process.env.SMOKE_DATA_SOURCE_ID;
const WANT_VERSION = process.env.SMOKE_EXPECT_VERSION;
if (!DS) throw new Error("set SMOKE_DATA_SOURCE_ID to a data source the integration can read");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const mcp = new Client({ name: "notion-mcp-smoke", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(URL_)));
const call = async (name, args) => {
  const r = await mcp.callTool({ name, arguments: args });
  const t = r.content.map((c) => c.text ?? "").join("");
  let json;
  try { json = JSON.parse(t); } catch { /* plain text */ }
  return { r, t, json };
};
const req = (args) => call("notion_request", args);

const info = mcp.getServerVersion();
check("serverInfo", info?.name === "notion-api", `${info?.name}@${info?.version}`);
if (WANT_VERSION) check("serverInfo.version", info?.version === WANT_VERSION, `want ${WANT_VERSION}`);

const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
check("tools listed", tools.join() === "notion_find_endpoints,notion_request", tools.join());

const eps = await call("notion_find_endpoints", { query: "" });
check("find_endpoints caps at 8", (eps.t.match(/"path"/g) ?? []).length <= 8, `${(eps.t.match(/"path"/g) ?? []).length} paths`);

const me = await req({ method: "GET", path: "/v1/users/me" });
check("GET users/me (compact)", !me.r.isError && !!me.json?.id, me.r.isError ? me.t.slice(0, 120) : "");

const q = { method: "POST", path: `/v1/data_sources/${DS}/query`, body: { page_size: 3 } };
const vals = await req({ ...q, format: "values" });
const row = vals.json?.results?.[0];
check("query format=values", !vals.r.isError && !!row?.props && !!row?.id, vals.r.isError ? vals.t.slice(0, 160) : `${vals.t.length} chars`);
const raw = await req({ ...q, format: "raw" });
check("query format=raw keeps full JSON", !raw.r.isError && !!raw.json?.results?.[0]?.properties, `${raw.t.length} chars`);
check("values smaller than raw", vals.t.length < raw.t.length, `${vals.t.length} < ${raw.t.length}`);

const big = await req({ method: "POST", path: q.path, body: { page_size: 100 }, format: "raw" });
let bigOk = !big.r.isError;
if (bigOk && big.t.length >= 24000) {
  check("long raw list is cut on whole rows and stays valid JSON", !!big.json?.results && (big.json.truncated_rows > 0 || big.json.has_more === true), `truncated_rows=${big.json?.truncated_rows}`);
} else {
  console.log(`SKIP  list truncation (raw page_size=100 was only ${big.t.length} chars; data source too small to hit the cap)`);
}

const slice = await req({ method: "GET", path: "/v1/users/me", offset: 20 });
check("offset on a read returns the rest", !slice.r.isError && slice.t.length > 0 && slice.t !== me.t, `${slice.t.length} chars`);

const w = await req({ method: "POST", path: "/v1/pages", body: {}, offset: 10 });
check("offset on a write is refused before Notion", w.r.isError === true && /offset is only for reads/.test(w.t), w.t.slice(0, 90));

const bad = await req({ method: "GET", path: "/v1/pages/00000000-0000-0000-0000-000000000000" });
check("Notion error comes back flagged", bad.r.isError === true, bad.t.slice(0, 90));

await mcp.close();
for (const method of ["GET", "DELETE"]) {
  const res = await fetch(URL_, { method });
  check(`${method} /mcp -> 405`, res.status === 405, `status ${res.status}`);
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
