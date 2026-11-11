// Live smoke test: read-only checks of a running server (local `npm run dev` or a deployed URL).
//
//   SMOKE_MCP_URL=http://127.0.0.1:8787/mcp SMOKE_DATA_SOURCE_ID=<id> node test/smoke.mjs
// Optional: SMOKE_EXPECT_VERSION=1.3.0, SMOKE_DELAY_MS=2500 (pause before each call),
// SMOKE_SCOPE=<a Preferences Scope option> (also checks governance_bundle with that scope),
// SMOKE_EXPECT_BUNDLE=1 (fail if governance_bundle isn't listed, e.g. GOVERNANCE_README_ID was not set).
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
const DELAY = Number(process.env.SMOKE_DELAY_MS ?? 0); // spacing for runs against production
const call = async (name, args) => {
  if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
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
const BUNDLE = tools.includes("governance_bundle");
if (process.env.SMOKE_EXPECT_BUNDLE) check("governance_bundle listed", BUNDLE, BUNDLE ? "" : "is GOVERNANCE_README_ID set?");
check(
  "tools listed",
  tools.join() === (BUNDLE ? "governance_bundle,notion_find_endpoints,notion_request" : "notion_find_endpoints,notion_request"),
  tools.join(),
);

if (BUNDLE) {
  // One reply is always whole JSON within the cap; what didn't fit is named in `pending`.
  const bundle = async (args) => {
    const { r, t } = await call("governance_bundle", args);
    if (r.isError) return { error: t };
    if (t.length > 24_000) return { error: `${t.length} chars, over the reply cap` };
    try { return { json: JSON.parse(t), chars: t.length }; } catch { return { error: `not JSON: ${t.slice(0, 120)}` }; }
  };
  const b = await bundle({});
  check("governance_bundle: no errors", !b.error && b.json.errors.length === 0, b.error ?? `${b.chars} chars ${JSON.stringify(b.json.errors).slice(0, 200)}`);
  check("governance_bundle: README markdown", typeof b.json?.readme?.markdown === "string" && b.json.readme.markdown.length > 0);
  check("governance_bundle: field rules have descriptions", !!b.json?.activity_log_fields?.fields?.some((f) => f.description));
  const SCOPE = process.env.SMOKE_SCOPE;
  if (SCOPE) {
    const s = await bundle({ scope: SCOPE });
    check(
      "governance_bundle: scoped preferences",
      !s.error && s.json.preferences?.scope === SCOPE && s.json.errors.length === 0,
      s.error ?? `${s.json.preferences?.rows?.length} rows`,
    );
  }
}

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
if (!big.r.isError && big.json?.page_size_reduced_to) {
  // A raw page of 100 rows is over the reply cap: the server must have fetched a smaller page, whole,
  // with a cursor that skips nothing.
  check(
    "long raw list is re-fetched smaller, whole rows, usable cursor",
    big.t.length <= 24000 && !big.json.truncated_rows && (!big.json.has_more || !!big.json.next_cursor),
    `page_size_reduced_to=${big.json.page_size_reduced_to}, ${big.t.length} chars, has_more=${big.json.has_more}`,
  );
} else if (!big.r.isError) {
  check("short raw list has a cursor whenever has_more", !big.json?.has_more || !!big.json?.next_cursor, `${big.t.length} chars`);
} else {
  check("long raw list request succeeded", false, big.t.slice(0, 120));
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
